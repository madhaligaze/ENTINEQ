import { fileURLToPath } from "node:url";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import replyFrom from "@fastify/reply-from";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { proxyWebSocket } from "./ws-proxy.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

/**
 * Заголовки запроса, которые попадают к бэкенду. Список закрытый: чужие Authorization, X-User-Token
 * и X-Forwarded-* от браузера до бэкенда не доходят (настоящие X-Forwarded-* добавляем сами).
 */
const FORWARDED_REQUEST_HEADERS = new Set([
  "accept",
  "accept-language",
  "content-length",
  "content-type",
  "cookie",
  "host",
  "origin",
  "referer",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "user-agent",
]);

/**
 * Фронтенд-сервис: отдаёт страницы и пересылает /api и /ws на бэкенд (адрес — BACKEND_URL).
 * Для браузера всё живёт на одном адресе, поэтому cookie, проверка Origin и политика безопасности
 * работают так же, как если бы бэкенд стоял рядом. Наружу бэкенд при этом открывать не нужно.
 */
export async function buildApp(cfg: Config): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      cfg.logLevel === "silent"
        ? false
        : { level: cfg.logLevel, redact: ["req.headers.authorization", "req.headers.cookie", 'req.headers["x-user-token"]'] },
    // Доверяем только заданному числу ближайших прокси: иначе посетитель мог бы подделать свой IP заголовком X-Forwarded-For.
    trustProxy: cfg.trustProxyHops > 0 ? (_address: string, hop: number) => hop < cfg.trustProxyHops : false,
    bodyLimit: 100 * 1024,
  });

  // Принимаем только JSON. text/plain — «простой» тип запроса, который браузер шлёт с чужого сайта без предварительной проверки.
  app.removeContentTypeParser("text/plain");

  app.setErrorHandler((error: unknown, req, reply) => {
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

  app.setNotFoundHandler((_req, reply) => reply.code(404).type("text/plain; charset=utf-8").send("Не найдено"));

  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        "default-src": ["'self'"],
        "script-src": ["'self'"],
        "style-src": ["'self'"],
        "img-src": ["'self'", "data:"],
        "connect-src": ["'self'"],
        "base-uri": ["'none'"],
        "form-action": ["'self'"],
        "frame-ancestors": ["'none'"],
        "object-src": ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => Object.assign(new Error("Too many requests"), { statusCode: 429 }),
  });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  await app.register(replyFrom, {
    base: cfg.backendOrigin,
    // Повторы запросов сами по себе не делаем: бэкенд сам решает, что безопасно повторять.
    retryMethods: [],
    disableRequestLogging: true,
    undici: { headersTimeout: cfg.backendTimeoutMs, bodyTimeout: cfg.backendTimeoutMs },
  });

  /** Живость самого сервиса: по ней Railway решает, что деплой удался. От бэкенда не зависит. */
  app.get("/healthz", { logLevel: "warn" }, async () => ({ ok: true }));

  /** Готовность: отвечает ли бэкенд. */
  app.get("/readyz", { logLevel: "warn" }, async (_req, reply) => {
    try {
      const response = await fetch(`${cfg.backendOrigin}/healthz`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return { ok: true };
      return reply.code(503).send({ ok: false, reason: "backend_unhealthy" });
    } catch {
      return reply.code(503).send({ ok: false, reason: "backend_unreachable" });
    }
  });

  const forward = (req: FastifyRequest, reply: FastifyReply) =>
    reply.from(req.raw.url ?? "/", {
      timeout: cfg.backendTimeoutMs,
      rewriteRequestHeaders: (request, headers) => {
        const allowed: Record<string, string | string[] | undefined> = {};
        for (const [name, value] of Object.entries(headers)) if (FORWARDED_REQUEST_HEADERS.has(name)) allowed[name] = value;
        allowed["x-forwarded-for"] = request.ip;
        allowed["x-forwarded-host"] = request.host;
        allowed["x-forwarded-proto"] = request.protocol;
        return allowed;
      },
      // Ответы API (вход, лимиты, история) ни браузер, ни прокси кэшировать не должны.
      rewriteHeaders: (headers) => ({ ...headers, "cache-control": "no-store" }),
      onError: (failed, { error }) => {
        failed.request.log.error({ err: error }, "бэкенд недоступен");
        if (failed.sent) return;
        failed
          .code(502)
          .header("cache-control", "no-store")
          .send({ error: { code: "upstream_unavailable", message: "Сервис временно недоступен. Попробуйте чуть позже." } });
      },
    });

  // Попытки входа и регистрации ограничиваем здесь, где виден настоящий IP посетителя.
  const authLimit = { rateLimit: { max: cfg.rateLimits.authPerMinute, timeWindow: "1 minute" } };
  app.post("/api/auth/login", { config: authLimit }, forward);
  app.post("/api/auth/register", { config: authLimit }, forward);
  app.all("/api/*", forward);

  app.get(
    "/ws",
    { websocket: true, config: { rateLimit: { max: cfg.rateLimits.wsPerMinute, timeWindow: "1 minute" } } },
    (socket, req) => proxyWebSocket(socket, req, cfg, req.log),
  );

  await app.register(fastifyStatic, {
    root: PUBLIC_DIR,
    // no-cache: браузер каждый раз сверяется с сервером (по ETag), поэтому после обновления не остаётся старого интерфейса.
    cacheControl: false,
    setHeaders: (res) => res.setHeader("Cache-Control", "no-cache"),
  });

  return app;
}
