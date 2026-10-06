import type { FastifyInstance, FastifyRequest } from "fastify";
import type { SessionGrant } from "../auth/service.js";
import { errors } from "../errors.js";
import { loginBody, registerBody } from "../schemas.js";
import type { Actor, PublicUser } from "../types.js";
import { registerChatRest } from "./chat-rest.js";
import { serveChat } from "./chat-socket.js";
import type { AppContext } from "./context.js";
import { assertInternalSecret, header } from "./guards.js";

/** Меняется при несовместимом изменении внутреннего API; публичное приложение сверяет его через /internal/ping. */
export const INTERNAL_CONTRACT_VERSION = 1;

/**
 * «Внутренняя дверь» для публичного приложения ENTINEQ. Требует общий секрет, а пользователя
 * определяет по его токену (X-User-Token). Принимает только публичные аккаунты: через эту дверь
 * владелец и доверенные не входят, и права выше публичных здесь не выдаются никому.
 */
export async function registerInternal(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const { cfg, auth, chat } = ctx;

  const tokenOf = (req: FastifyRequest) => header(req, "x-user-token");
  const actorOf = async (req: FastifyRequest): Promise<Actor> => {
    const actor = await auth.authenticate(tokenOf(req), "internal");
    if (!actor) throw errors.unauthorized();
    return actor;
  };

  const grantResponse = async (grant: SessionGrant & { user: PublicUser }) => ({
    token: grant.token,
    expiresAt: grant.expiresAt.toISOString(),
    user: grant.user,
    usage: await chat.usageFor({ userId: grant.user.id, email: grant.user.email, role: grant.user.role, entry: "internal" }),
  });

  await app.register(
    async (internal) => {
      // Секрет проверяется до всего остального, на каждом маршруте этой области (включая WebSocket).
      internal.addHook("onRequest", async (req) => assertInternalSecret(req, cfg.internalApiSecret));

      /** Проверка связки: секрет принят и версия контракта совпадает с ожидаемой публичным приложением. */
      internal.get("/ping", async () => ({ ok: true, service: "entineq-agent", contract: INTERNAL_CONTRACT_VERSION }));

      internal.post("/auth/register", async (req, reply) => {
        const body = registerBody.parse(req.body);
        return reply.code(201).send(await grantResponse(await auth.register(body)));
      });

      internal.post("/auth/login", async (req) => {
        const body = loginBody.parse(req.body);
        return grantResponse(await auth.login({ ...body, entry: "internal" }));
      });

      internal.post("/auth/logout", async (req, reply) => {
        await auth.logout(tokenOf(req));
        return reply.code(204).send();
      });

      registerChatRest(internal, ctx, actorOf);

      internal.get("/ws", { websocket: true }, (socket, req) => {
        const token = tokenOf(req);
        // См. комментарий в direct.ts: обработчик вешаем сразу, проверка личности идёт параллельно.
        serveChat(socket, ctx, () => auth.authenticate(token, "internal"), req.log);
        void auth.authenticate(token, "internal").then(
          (actor) => {
            if (!actor) socket.close(4401, "unauthorized");
          },
          (error) => {
            req.log.error(error);
            socket.close(1011, "internal error");
          },
        );
      });
    },
    { prefix: "/internal" },
  );
}
