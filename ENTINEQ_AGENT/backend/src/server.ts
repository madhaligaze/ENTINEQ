import { join } from "node:path";
import { createPgSessionStore } from "./agent/session-store.js";
import { ClaudeAgentRunner } from "./agent/claude-runner.js";
import { FakeAgentRunner } from "./agent/fake-runner.js";
import { PasswordHasher } from "./auth/password.js";
import { buildApp } from "./app.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { openDb } from "./db/index.js";
import { listen } from "./listen.js";

function readConfig(): Config {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const cfg = readConfig();

const handle = await openDb(
  cfg.databaseUrl
    ? { url: cfg.databaseUrl, ssl: cfg.databaseSsl, log: (message) => console.error(message) }
    : { pglite: join(cfg.dataDir, "pglite") },
);
await handle.migrate();

const runner =
  cfg.agentRunner === "fake"
    ? new FakeAgentRunner()
    : new ClaudeAgentRunner(cfg.anthropicApiKey!, createPgSessionStore(handle.db));

const { app, auth, chat } = await buildApp({ cfg, db: handle.db, runner, hasher: new PasswordHasher() });

if (!cfg.databaseUrl) app.log.warn("DATABASE_URL не задан — используется локальная встроенная БД (только для разработки).");
if (cfg.agentRunner === "fake") app.log.warn("AGENT_RUNNER=fake — вместо Claude отвечает заглушка. Для настоящей работы уберите эту переменную.");

if (cfg.ownerEmail && cfg.ownerPassword) {
  const created = await auth.bootstrapOwner(cfg.ownerEmail, cfg.ownerPassword);
  app.log.info(created ? `Создан владелец ${cfg.ownerEmail}.` : "Владелец уже существует (OWNER_PASSWORD можно удалить из переменных).");
} else {
  app.log.warn("OWNER_EMAIL/OWNER_PASSWORD не заданы — первый вход невозможен, пока владельца нет.");
}

const purgeTimer = setInterval(() => {
  auth.purgeExpired().catch((error) => app.log.error(error));
}, 3_600_000);
purgeTimer.unref();

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "останавливаюсь");
  setTimeout(() => process.exit(1), 45_000).unref();
  try {
    await app.close();
    await chat.drain(30_000);
    await handle.close();
  } catch (error) {
    app.log.error(error);
  }
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

const host = await listen(app, cfg.port, cfg.host);
app.log.info(`Слушаю ${host}:${cfg.port}.`);
