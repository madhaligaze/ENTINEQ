import { z } from "zod";
import { PASSWORD_MAX, PASSWORD_MIN } from "./auth/service.js";
import "./zod-setup.js";

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const newPassword = z
  .string()
  .min(PASSWORD_MIN, `Пароль: минимум ${PASSWORD_MIN} символов`)
  .max(PASSWORD_MAX, `Пароль: максимум ${PASSWORD_MAX} символов`);
/** Деньги в долларах. null - «без лимита». */
const money = z.number().min(0).max(1_000_000);

export const loginBody = z.object({ email, password: z.string().min(1).max(PASSWORD_MAX) });

export const registerBody = z.object({
  email,
  password: newPassword,
  inviteCode: z.string().trim().min(6, "Введите код приглашения").max(64),
});

/** Сообщение, которое интерфейс присылает по WebSocket. */
export const clientMessage = z.object({
  type: z.literal("user"),
  text: z.string().trim().min(1, "Сообщение пустое").max(20_000, "Сообщение слишком длинное (максимум 20 000 символов)"),
  conversationId: z.uuid().optional(),
});

export const idParam = z.object({ id: z.uuid() });

export const createUserBody = z.object({
  email,
  password: newPassword,
  role: z.enum(["trusted", "public"]),
  monthlyBudgetUsd: money.nullable().optional(),
  windowLimitUsd: money.nullable().optional(),
});

export const patchUserBody = z
  .object({
    monthlyBudgetUsd: money.nullable().optional(),
    windowLimitUsd: money.nullable().optional(),
    isActive: z.boolean().optional(),
    password: newPassword.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), "Нечего менять");

export const createInvitesBody = z.object({
  count: z.number().int().min(1).max(50).default(1),
  expiresInDays: z.number().int().min(1).max(90).default(14),
  monthlyBudgetUsd: money.nullable().optional(),
  windowLimitUsd: money.nullable().optional(),
});

export const monthQuery = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Месяц в формате ГГГГ-ММ").optional(),
});
