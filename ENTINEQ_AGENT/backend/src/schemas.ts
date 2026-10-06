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

export const registerBody = z.object({ email, password: newPassword });

/** Сообщение, которое интерфейс присылает по WebSocket. */
export const clientMessage = z.object({
  type: z.literal("user"),
  text: z.string().trim().min(1, "Сообщение пустое").max(20_000, "Сообщение слишком длинное (максимум 20 000 символов)"),
  conversationId: z.uuid().optional(),
  /** Только для нового диалога: terminal - вести его в песочнице (по подписке). */
  mode: z.enum(["chat", "terminal"]).optional(),
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
    /** Подписка до этого момента (ISO-время); null - снять подписку. Только для публичных пользователей. */
    subscribedUntil: z.iso.datetime({ offset: true }).nullable().optional(),
    /** Продлить подписку на столько суток: от текущего конца либо от сегодня, если подписки нет. */
    subscriptionDays: z.number().int().min(1).max(3650).optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), "Нечего менять")
  .refine((body) => !(body.subscribedUntil !== undefined && body.subscriptionDays !== undefined), "Укажите либо дату подписки, либо число суток");

export const monthQuery = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Месяц в формате ГГГГ-ММ").optional(),
});
