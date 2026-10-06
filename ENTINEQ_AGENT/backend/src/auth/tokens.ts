import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Токен сессии: 256 бит случайности. В БД лежит только его sha256. */
export const newSessionToken = () => randomBytes(32).toString("base64url");

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

// 32 символа (алфавит Crockford без I, L, O, U): 256 % 32 == 0, поэтому выбор символа без перекоса.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Код приглашения вида ENT-XXXX-XXXX-XXXX (60 бит случайности). */
export function newInviteCode(): string {
  const bytes = randomBytes(12);
  let body = "";
  for (const byte of bytes) body += ALPHABET[byte & 31];
  return `ENT-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
}

/** Приводит введённый код к каноническому виду: регистр, дефисы и пробелы не важны, префикс ENT можно опустить. */
export function normalizeInviteCode(input: string): string {
  let code = input.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (code.length === 12) code = `ENT${code}`;
  return code;
}

export const hashInviteCode = (input: string) => hashToken(normalizeInviteCode(input));

/** Сравнение секретов без утечки по времени. */
export function safeEqual(a: string, b: string): boolean {
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}
