import { z } from "zod";
import "./zod-setup.js";

/**
 * Контракт внутреннего API ENTINEQ_AGENT, как его ждёт это приложение.
 * Две копии (здесь и в ядре) живут в разных репозиториях, поэтому ответы ядра проверяются на лету:
 * при расхождении версий пользователь увидит понятную ошибку, а в логах будет причина.
 * Версия меняется вместе с ядром (INTERNAL_CONTRACT_VERSION в ENTINEQ_AGENT/src/routes/internal.ts).
 */
export const EXPECTED_CONTRACT = 1;

export const userSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: z.enum(["owner", "trusted", "public"]),
});

export const usageSchema = z.object({
  month: z.string(),
  monthSpentUsd: z.number(),
  monthBudgetUsd: z.number().nullable(),
  monthResetsAt: z.string(),
  window: z.object({
    hours: z.number(),
    active: z.boolean(),
    startedAt: z.string().nullable(),
    resetsAt: z.string().nullable(),
    spentUsd: z.number(),
    limitUsd: z.number().nullable(),
  }),
});

export const grantSchema = z.object({
  token: z.string().min(20),
  expiresAt: z.string(),
  user: userSchema,
  usage: usageSchema,
});

export const meSchema = z.object({ user: userSchema, usage: usageSchema });

export const conversationsSchema = z.object({
  conversations: z.array(z.object({ id: z.string(), title: z.string(), updatedAt: z.string() })),
});

export const messagesSchema = z.object({
  messages: z.array(z.object({ id: z.number(), role: z.enum(["user", "assistant", "tool"]), content: z.string(), createdAt: z.string() })),
});

export const pingSchema = z.object({ ok: z.literal(true), service: z.string(), contract: z.number() });

export const coreErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), resetsAt: z.string().optional() }),
});

/** Тела запросов от браузера. Правила те же, что в ядре: ядро проверяет их повторно. */
const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const newPassword = z.string().min(10, "Пароль: минимум 10 символов").max(128, "Пароль: максимум 128 символов");

export const loginBody = z.object({ email, password: z.string().min(1).max(128) });
export const registerBody = z.object({
  email,
  password: newPassword,
  inviteCode: z.string().trim().min(6, "Введите код приглашения").max(64),
});
export const idParam = z.object({ id: z.uuid() });

/** Сообщение, которое интерфейс присылает по WebSocket. */
export const clientMessage = z.object({
  type: z.literal("user"),
  text: z.string().trim().min(1, "Сообщение пустое").max(20_000, "Сообщение слишком длинное (максимум 20 000 символов)"),
  conversationId: z.uuid().optional(),
});
