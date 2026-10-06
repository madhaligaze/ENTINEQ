import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import type { Config } from "./config.js";
import { EXPECTED_CONTRACT } from "./contract.js";
import { CoreClient } from "./core-client.js";
import { AppError } from "./errors.js";
import { registerApi } from "./routes/api.js";
import { registerWs } from "./routes/ws.js";

export interface BuiltApp {
  app: FastifyInstance;
  core: CoreClient;
}

export async function buildApp(cfg: Config): Promise<BuiltApp> {
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

  const core = new CoreClient(cfg, app.log);

  /** Корень - просто «жив ли и что за сервис»: пригодится, когда адрес бэкенда открывают в браузере. */
  app.get("/", async () => ({ service: "entineq-backend", ok: true }));

  /** Живость самого приложения: по ней Railway решает, что деплой удался. От доступности ядра не зависит. */
  // Пробы здоровья дёргаются каждые несколько секунд - их запросы в журнал не пишем.
  app.get("/healthz", { logLevel: "warn" }, async () => ({ ok: true }));

  /** Готовность: видит ли приложение ядро, принял ли оно секрет и совпадает ли версия контракта. */
  app.get("/readyz", { logLevel: "warn" }, async (_req, reply) => {
    try {
      const ping = await core.ping();
      if (ping.contract !== EXPECTED_CONTRACT) {
        return reply.code(503).send({ ok: false, reason: "contract_mismatch", expected: EXPECTED_CONTRACT, actual: ping.contract });
      }
      return { ok: true };
    } catch (error) {
      // Нет маршрута /internal/ping - значит, ядро старше этого приложения: версии не совпадают.
      const reason = error instanceof AppError ? (error.code === "not_found" ? "contract_mismatch" : error.code) : "core_unreachable";
      return reply.code(503).send({ ok: false, reason });
    }
  });

  await registerApi(app, cfg, core);
  await registerWs(app, cfg);

  return { app, core };
}
