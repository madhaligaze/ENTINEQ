import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { AgentRunner } from "./agent/types.js";
import { AuthService } from "./auth/service.js";
import { PasswordHasher } from "./auth/password.js";
import { ChatService, type Runners } from "./chat/service.js";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { sql } from "drizzle-orm";
import { AppError } from "./errors.js";
import { registerDirect } from "./routes/direct.js";
import { registerInternal } from "./routes/internal.js";
import type { AppContext } from "./routes/context.js";

export interface AppDeps {
  cfg: Config;
  db: Db;
  /** Движок агента с терминалом в контейнере ядра (владелец и доверенные). */
  runner: AgentRunner;
  /** Публичный чат без инструментов. Не задан - тот же раннер (так устроены заглушка и тесты). */
  chatRunner?: AgentRunner;
  /** Терминал в изолированной песочнице для подписчиков. Нужен, если SANDBOX_MODE=managed; не задан - тот же раннер. */
  sandboxRunner?: AgentRunner;
  hasher?: PasswordHasher;
  now?: () => Date;
}

export interface BuiltApp {
  app: FastifyInstance;
  auth: AuthService;
  chat: ChatService;
}

export async function buildApp(deps: AppDeps): Promise<BuiltApp> {
  const { cfg, db } = deps;

  const app = Fastify({
    logger:
      cfg.logLevel === "silent"
        ? false
        : { level: cfg.logLevel, redact: ["req.headers.authorization", "req.headers.cookie", 'req.headers["x-user-token"]'] },
    // Доверяем только заданному числу ближайших прокси: иначе клиент мог бы подделать свой IP заголовком X-Forwarded-For.
    trustProxy: cfg.trustProxyHops > 0 ? (_address: string, hop: number) => hop < cfg.trustProxyHops : false,
    bodyLimit: 100 * 1024,
  });

  // Принимаем только JSON. text/plain - «простой» тип запроса, который браузер шлёт с чужого сайта без предварительной проверки.
  app.removeContentTypeParser("text/plain");

  app.setErrorHandler((error: unknown, req, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.status).send({
        error: { code: error.code, message: error.message, ...(error.resetsAt ? { resetsAt: error.resetsAt } : {}) },
      });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: { code: "invalid_request", message: error.issues[0]?.message ?? "Некорректные данные запроса." } });
    }
    const status = (error as { statusCode?: unknown }).statusCode;
    if (status === 429) {
      return reply.code(429).send({ error: { code: "rate_limited", message: "Слишком много попыток. Повторите позже." } });
    }
    if (typeof status === "number" && status >= 400 && status < 500) {
      const message = status === 413 ? "Слишком большой запрос." : status === 415 ? "Ожидается JSON." : "Некорректный запрос.";
      return reply.code(status).send({ error: { code: "bad_request", message } });
    }
    req.log.error(error);
    return reply.code(500).send({ error: { code: "internal_error", message: "Внутренняя ошибка сервера." } });
  });

  // Это чистый API: страниц здесь нет, на любой неизвестный адрес - одинаковый JSON.
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { code: "not_found", message: "Не найдено." } }));

  await app.register(helmet, {
    // Для JSON-ответов браузеру ничего загружать не нужно: запрещаем всё.
    contentSecurityPolicy: { useDefaults: false, directives: { "default-src": ["'none'"], "frame-ancestors": ["'none'"] } },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => Object.assign(new Error("Too many requests"), { statusCode: 429 }),
  });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  const hasher = deps.hasher ?? new PasswordHasher();
  const auth = new AuthService(db, cfg.sessionTtlDays, hasher, deps.now, {
    signupIpDailyCap: cfg.signup.ipDailyCap,
    publicDefaults: cfg.defaults.public,
  });
  const runners: Runners = {
    agent: deps.runner,
    chat: deps.chatRunner ?? deps.runner,
    managed: cfg.sandbox.mode === "managed" ? (deps.sandboxRunner ?? deps.runner) : null,
  };
  const chat = new ChatService({ db, runners, cfg, log: app.log, now: deps.now });
  const ctx: AppContext = { cfg, db, auth, chat };

  /** Корень - просто «жив ли и что за сервис»: пригодится, когда адрес бэкенда открывают в браузере. */
  app.get("/", async () => ({ service: "entineq-agent-backend", ok: true }));
  // Пробы здоровья дёргаются каждые несколько секунд - их запросы в журнал не пишем.
  app.get("/healthz", { logLevel: "warn" }, async () => ({ ok: true }));
  app.get("/readyz", { logLevel: "warn" }, async (_req, reply) => {
    try {
      await db.execute(sql`select 1`);
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  await registerDirect(app, ctx);
  await registerInternal(app, ctx);

  return { app, auth, chat };
}
