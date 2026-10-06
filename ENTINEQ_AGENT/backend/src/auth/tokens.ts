import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Токен сессии: 256 бит случайности. В БД лежит только его sha256. */
export const newSessionToken = () => randomBytes(32).toString("base64url");

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/** Сравнение секретов без утечки по времени. */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}
