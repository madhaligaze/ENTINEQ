import type { FastifyInstance, FastifyRequest } from "fastify";
import { errors } from "../errors.js";
import { loginBody } from "../schemas.js";
import type { Actor } from "../types.js";
import { registerAdmin } from "./admin.js";
import { serveChat } from "./chat-socket.js";
import { registerChatRest } from "./chat-rest.js";
import type { AppContext } from "./context.js";
import { assertSameOrigin, clearSessionCookie, csrfHook, SESSION_COOKIE, setSessionCookie } from "./guards.js";

/**
 * «Прямая дверь»: собственный интерфейс ENTINEQ_AGENT для владельца и доверенных людей.
 * Вход по паролю, сессия - в httpOnly-cookie.
 */
export async function registerDirect(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { cfg, auth, chat } = ctx;

  const actorOf = async (req: FastifyRequest): Promise<Actor> => {
    const actor = await auth.authenticate(req.cookies[SESSION_COOKIE], "direct");
    if (!actor) throw errors.unauthorized();
    return actor;
  };
  const ownerOf = async (req: FastifyRequest): Promise<Actor> => {
    const actor = await actorOf(req);
    if (actor.role !== "owner") throw errors.forbidden();
    return actor;
  };

  await app.register(
    async (api) => {
      api.addHook("onRequest", (req) => csrfHook(req, cfg));

      api.post("/auth/login", { config: { rateLimit: { max: cfg.rateLimits.loginPerMinute, timeWindow: "1 minute" } } }, async (req, reply) => {
        const body = loginBody.parse(req.body);
        const session = await auth.login({ ...body, entry: "direct" });
        setSessionCookie(reply, cfg, session.token, session.expiresAt);
        const actor: Actor = { userId: session.user.id, email: session.user.email, role: session.user.role, entry: "direct" };
        return { user: session.user, usage: await chat.usageFor(actor) };
      });

      api.post("/auth/logout", async (req, reply) => {
        await auth.logout(req.cookies[SESSION_COOKIE]);
        clearSessionCookie(reply, cfg);
        return reply.code(204).send();
      });

      registerChatRest(api, ctx, actorOf);
      registerAdmin(api, ctx, ownerOf);
    },
    { prefix: "/api" },
  );

  app.get(
    "/ws",
    {
      websocket: true,
      preValidation: async (req) => assertSameOrigin(req, cfg),
      config: { rateLimit: { max: cfg.rateLimits.wsPerMinute, timeWindow: "1 minute" } },
    },
    (socket, req) => {
      const token = req.cookies[SESSION_COOKIE];
      // Обработчик сообщений вешаем сразу: клиент может написать в ту же миллисекунду, как соединение открылось.
      // Каждое сообщение всё равно проверяет личность заново, а проверка ниже лишь рано закрывает чужое соединение.
      serveChat(socket, ctx, () => auth.authenticate(token, "direct"), req.log);
      void auth.authenticate(token, "direct").then(
        (actor) => {
          if (!actor) socket.close(4401, "unauthorized");
        },
        (error) => {
          req.log.error(error);
          socket.close(1011, "internal error");
        },
      );
    },
  );
}
