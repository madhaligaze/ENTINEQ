import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase } from "drizzle-orm/pg-core";
import pg from "pg";
import * as schema from "./schema.js";

export { schema };

/** Общий тип для обоих драйверов (pg в проде, PGlite в тестах и локальной разработке без Docker). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Db = PgDatabase<any, typeof schema>;

export interface DbHandle {
  db: Db;
  kind: "pg" | "pglite";
  migrate(): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export type OpenDbOptions =
  | { url: string; ssl?: boolean; log?: (message: string) => void }
  | { pglite: "memory" | string };

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle", import.meta.url));

export async function openDb(options: OpenDbOptions): Promise<DbHandle> {
  if ("url" in options) {
    const pool = new pg.Pool({
      connectionString: options.url,
      ssl: options.ssl ? { rejectUnauthorized: false } : undefined,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    // Ошибка на простаивающем соединении не должна ронять процесс.
    pool.on("error", (error) => options.log?.(`pg pool error: ${error.message}`));
    const db = drizzlePg(pool, { schema });
    return {
      db,
      kind: "pg",
      migrate: () => migratePg(db, { migrationsFolder: MIGRATIONS_FOLDER }),
      ping: async () => {
        await db.execute(sql`select 1`);
      },
      close: () => pool.end(),
    };
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const client = options.pglite === "memory" ? new PGlite() : new PGlite(options.pglite);
  const db = drizzle(client, { schema });
  return {
    db,
    kind: "pglite",
    migrate: () => migrate(db, { migrationsFolder: MIGRATIONS_FOLDER }),
    ping: async () => {
      await db.execute(sql`select 1`);
    },
    close: () => client.close(),
  };
}
