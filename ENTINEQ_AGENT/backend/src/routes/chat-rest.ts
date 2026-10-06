import type { FastifyInstance, FastifyRequest } from "fastify";
import { idParam } from "../schemas.js";
import type { Actor } from "../types.js";
import type { AppContext } from "./context.js";

/** Маршруты чтения, общие для обеих «дверей»: кто спрашивает - определяет `actorOf`. */
export function registerChatRest(scope: FastifyInstance, ctx: AppContext, actorOf: (req: FastifyRequest) => Promise<Actor>): void {
  scope.get("/me", async (req) => {
    const actor = await actorOf(req);
    return {
      user: { id: actor.userId, email: actor.email, role: actor.role },
      usage: await ctx.chat.usageFor(actor),
    };
  });

  scope.get("/conversations", async (req) => {
    const actor = await actorOf(req);
    const rows = await ctx.chat.listConversations(actor);
    return { conversations: rows.map((row) => ({ id: row.id, title: row.title, updatedAt: row.updatedAt.toISOString() })) };
  });

  scope.get("/conversations/:id/messages", async (req) => {
    const actor = await actorOf(req);
    const { id } = idParam.parse(req.params);
    const rows = await ctx.chat.messagesOf(actor, id);
    return {
      messages: rows.map((row) => ({ id: row.id, role: row.role, content: row.content, createdAt: row.createdAt.toISOString() })),
    };
  });
}
