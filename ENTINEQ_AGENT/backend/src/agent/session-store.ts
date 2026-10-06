import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { sdkSessionEntries } from "../db/schema.js";

const CHUNK = 500;

/**
 * Postgres не принимает символ NUL внутри JSONB. Убираем его из строк, не затрагивая
 * буквальную последовательность «\u0000» (обратная косая, экранированная в JSON как \\u0000).
 */
export function stripNul(entry: SessionStoreEntry): SessionStoreEntry {
  const text = JSON.stringify(entry);
  if (!text.includes("\\u0000")) return entry;
  return JSON.parse(text.replace(/(?<!\\)((?:\\\\)*)\\u0000/g, "$1")) as SessionStoreEntry;
}

const keyMatch = (key: SessionKey) =>
  and(
    eq(sdkSessionEntries.projectKey, key.projectKey),
    eq(sdkSessionEntries.sessionId, key.sessionId),
    eq(sdkSessionEntries.subpath, key.subpath ?? ""),
  );

/**
 * Хранилище транскриптов сессий Agent SDK в Postgres. Нужно, потому что локальный диск на Railway
 * сбрасывается при каждом деплое, а без транскрипта диалог нельзя продолжить (resume).
 */
export function createPgSessionStore(db: Db): SessionStore {
  return {
    async append(key, entries) {
      for (let i = 0; i < entries.length; i += CHUNK) {
        const rows = entries.slice(i, i + CHUNK).map((entry) => {
          const safe = stripNul(entry);
          return {
            projectKey: key.projectKey,
            sessionId: key.sessionId,
            subpath: key.subpath ?? "",
            uuid: typeof safe.uuid === "string" ? safe.uuid : null,
            entry: safe,
          };
        });
        // Повторная отправка той же записи (по uuid) не создаёт дубликатов.
        await db.insert(sdkSessionEntries).values(rows).onConflictDoNothing();
      }
    },

    async load(key) {
      const rows = await db
        .select({ entry: sdkSessionEntries.entry })
        .from(sdkSessionEntries)
        .where(keyMatch(key))
        .orderBy(sdkSessionEntries.seq);
      return rows.length ? rows.map((row) => row.entry as SessionStoreEntry) : null;
    },

    async listSessions(projectKey) {
      const rows = await db
        .select({ sessionId: sdkSessionEntries.sessionId, mtime: sql<Date>`max(${sdkSessionEntries.createdAt})` })
        .from(sdkSessionEntries)
        .where(and(eq(sdkSessionEntries.projectKey, projectKey), eq(sdkSessionEntries.subpath, "")))
        .groupBy(sdkSessionEntries.sessionId);
      return rows.map((row) => ({ sessionId: row.sessionId, mtime: Math.floor(new Date(row.mtime).getTime()) }));
    },

    async delete(key) {
      // Удаление основной сессии забирает и её субагентов.
      const condition = key.subpath === undefined
        ? and(eq(sdkSessionEntries.projectKey, key.projectKey), eq(sdkSessionEntries.sessionId, key.sessionId))
        : keyMatch(key);
      await db.delete(sdkSessionEntries).where(condition);
    },

    async listSubkeys({ projectKey, sessionId }) {
      const rows = await db
        .selectDistinct({ subpath: sdkSessionEntries.subpath })
        .from(sdkSessionEntries)
        .where(and(eq(sdkSessionEntries.projectKey, projectKey), eq(sdkSessionEntries.sessionId, sessionId)));
      return rows.map((row) => row.subpath).filter((subpath) => subpath !== "");
    },
  };
}
