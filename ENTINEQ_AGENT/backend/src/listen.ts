import type { FastifyInstance } from "fastify";

/** Ошибки, при которых адрес не подходит этой машине (а не порт занят) — тогда пробуем следующий. */
const UNSUPPORTED = new Set(["EAFNOSUPPORT", "EADDRNOTAVAIL", "EINVAL"]);

/**
 * Слушает на всех интерфейсах. Сначала `::` (принимает и IPv6, и IPv4 — приватная сеть Railway местами только IPv6),
 * а если в системе нет IPv6 — `0.0.0.0`. Если адрес задан явно (`HOST`), используется только он.
 */
export async function listen(app: FastifyInstance, port: number, host?: string): Promise<string> {
  const candidates = host ? [host] : ["::", "0.0.0.0"];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      await app.listen({ host: candidate, port });
      return candidate;
    } catch (error) {
      lastError = error;
      if (!UNSUPPORTED.has((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  }
  throw lastError;
}
