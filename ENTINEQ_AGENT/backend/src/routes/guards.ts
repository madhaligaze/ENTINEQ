import type { FastifyReply, FastifyRequest } from "fastify";
import { safeEqual } from "../auth/tokens.js";
import type { Config } from "../config.js";
import { AppError, errors } from "../errors.js";

/** Cookie собственного входа ENTINEQ_AGENT. Имя отличается от cookie публичного приложения: на localhost cookie общие для всех портов. */
export const SESSION_COOKIE = "entineq_agent_session";

export function header(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Внутренний канал доступен только тому, кто знает общий секрет. Все отказы выглядят одинаково.
 * Код отличается от `unauthorized` (пользователь не вошёл): так публичное приложение отличает
 * неверно настроенный секрет от обычного выхода пользователя.
 */
export function assertInternalSecret(req: FastifyRequest, secret: string): void {
  const authorization = header(req, "authorization") ?? "";
  const presented = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!presented || !safeEqual(presented, secret)) throw new AppError("internal_unauthorized", "Нет доступа.", 401);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Защита от CSRF и перехвата WebSocket из чужого сайта. Браузер всегда сообщает Origin
 * на запросах, меняющих состояние, и при открытии WebSocket — он должен совпасть с нашим адресом.
 */
export function isOriginAllowed(req: FastifyRequest, allowedOrigins: string[]): boolean {
  const origin = header(req, "origin");
  if (origin !== undefined) {
    if (allowedOrigins.length) return allowedOrigins.includes(origin);
    try {
      return new URL(origin).host === header(req, "host");
    } catch {
      return false;
    }
  }
  // Origin нет: это не запрос из страницы (curl, сервер). Но если браузер прямо говорит «чужой сайт» — отказываем.
  const site = header(req, "sec-fetch-site");
  return site === undefined || site === "same-origin" || site === "none";
}

export function assertSameOrigin(req: FastifyRequest, cfg: Pick<Config, "allowedOrigins">): void {
  if (isOriginAllowed(req, cfg.allowedOrigins)) return;
  // Для владельца сервиса: самая частая причина — в ALLOWED_ORIGINS не тот адрес фронтенда.
  req.log.warn({ origin: header(req, "origin"), allowedOrigins: cfg.allowedOrigins }, "Origin не совпал с ALLOWED_ORIGINS");
  throw errors.forbidden("Запрос с чужого сайта отклонён.");
}

/** Хук для маршрутов, меняющих состояние. */
export async function csrfHook(req: FastifyRequest, cfg: Pick<Config, "allowedOrigins">): Promise<void> {
  if (!SAFE_METHODS.has(req.method)) assertSameOrigin(req, cfg);
}

export function setSessionCookie(reply: FastifyReply, cfg: Pick<Config, "cookieSecure">, token: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: cfg.cookieSecure,
    path: "/",
    expires: expiresAt,
  });
}

export function clearSessionCookie(reply: FastifyReply, cfg: Pick<Config, "cookieSecure">): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/", httpOnly: true, sameSite: "lax", secure: cfg.cookieSecure });
}
