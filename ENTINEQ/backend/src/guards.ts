import type { FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { errors } from "./errors.js";

/** Cookie публичного приложения. Имя отличается от cookie ядра: на localhost cookie общие для всех портов. */
export const SESSION_COOKIE = "entineq_session";

export function header(req: FastifyRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Защита от CSRF и перехвата WebSocket из чужого сайта: Origin должен совпасть с нашим адресом.
 * Без Origin (curl, сервер) пропускаем, но если браузер сам говорит «чужой сайт» - отказываем.
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
  const site = header(req, "sec-fetch-site");
  return site === undefined || site === "same-origin" || site === "none";
}

export function assertSameOrigin(req: FastifyRequest, cfg: Pick<Config, "allowedOrigins">): void {
  if (isOriginAllowed(req, cfg.allowedOrigins)) return;
  // Для владельца сервиса: самая частая причина - в ALLOWED_ORIGINS не тот адрес фронтенда.
  req.log.warn({ origin: header(req, "origin"), allowedOrigins: cfg.allowedOrigins }, "Origin не совпал с ALLOWED_ORIGINS");
  throw errors.forbidden("Запрос с чужого сайта отклонён.");
}

export async function csrfHook(req: FastifyRequest, cfg: Pick<Config, "allowedOrigins">): Promise<void> {
  if (!SAFE_METHODS.has(req.method)) assertSameOrigin(req, cfg);
}

export function setSessionCookie(reply: FastifyReply, cfg: Pick<Config, "cookieSecure">, token: string, expiresAt: Date): void {
  reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: cfg.cookieSecure, path: "/", expires: expiresAt });
}

export function clearSessionCookie(reply: FastifyReply, cfg: Pick<Config, "cookieSecure">): void {
  reply.clearCookie(SESSION_COOKIE, { path: "/", httpOnly: true, sameSite: "lax", secure: cfg.cookieSecure });
}
