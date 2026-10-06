import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.js";
import { idParam, loginBody, registerBody } from "../contract.js";
import type { CoreClient } from "../core-client.js";
import { AppError, errors } from "../errors.js";
import { clearSessionCookie, csrfHook, SESSION_COOKIE, setSessionCookie } from "../guards.js";

/**
 * REST для браузера (запросы приходят от фронтенд-сервиса). Всё делает ядро: здесь проверяется ввод, ставится cookie и пересылаются запросы.
 * Токен сессии живёт только в httpOnly-cookie - скрипт на странице его не видит.
 */
export async function registerApi(app: FastifyInstance, cfg: Config, core: CoreClient): Promise<void> {
  const tokenOf = (req: FastifyRequest): string => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) throw errors.unauthorized();
    return token;
  };

  /** Выполняет запрос от имени пользователя; если ядро говорит «сессия недействительна» - стираем cookie. */
  const asUser = async <T>(req: FastifyRequest, reply: FastifyReply, fn: (token: string) => Promise<T>): Promise<T> => {
    try {
      return await fn(tokenOf(req));
    } catch (error) {
      if (error instanceof AppError && error.code === "unauthorized") clearSessionCookie(reply, cfg);
      throw error;
    }
  };

  const authLimit = { rateLimit: { max: cfg.rateLimits.authPerMinute, timeWindow: "1 minute" } };

  await app.register(
    async (api) => {
      api.addHook("onRequest", (req) => csrfHook(req, cfg));

      api.post("/auth/register", { config: authLimit }, async (req, reply) => {
        const grant = await core.register(registerBody.parse(req.body));
        setSessionCookie(reply, cfg, grant.token, new Date(grant.expiresAt));
        return reply.code(201).send({ user: grant.user, usage: grant.usage });
      });

      api.post("/auth/login", { config: authLimit }, async (req, reply) => {
        const grant = await core.login(loginBody.parse(req.body));
        setSessionCookie(reply, cfg, grant.token, new Date(grant.expiresAt));
        return { user: grant.user, usage: grant.usage };
      });

      api.post("/auth/logout", async (req, reply) => {
        const token = req.cookies[SESSION_COOKIE];
        clearSessionCookie(reply, cfg);
        if (token) {
          try {
            await core.logout(token);
          } catch (error) {
            // Выход для пользователя состоялся (cookie стёрта); сбой ядра только пишем в лог.
            req.log.warn({ err: error }, "не удалось закрыть сессию в ядре");
          }
        }
        return reply.code(204).send();
      });

      api.get("/me", async (req, reply) => asUser(req, reply, (token) => core.me(token)));
      api.get("/conversations", async (req, reply) => asUser(req, reply, (token) => core.conversations(token)));
      api.get("/conversations/:id/messages", async (req, reply) => {
        const { id } = idParam.parse(req.params);
        return asUser(req, reply, (token) => core.messages(token, id));
      });
    },
    { prefix: "/api" },
  );
}
