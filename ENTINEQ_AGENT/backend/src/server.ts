import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { ChatRunner } from "./agent/chat-runner.js";
import { ClaudeAgentRunner } from "./agent/claude-runner.js";
import { FakeAgentRunner } from "./agent/fake-runner.js";
import { ManagedAgentRunner } from "./agent/managed-runner.js";
import { createPgSessionStore } from "./agent/session-store.js";
import type { AgentRunner } from "./agent/types.js";
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

// Три движка: агент в контейнере ядра (владелец и доверенные), чат без инструментов (публичные), песочница (подписчики, по желанию).
let runner: AgentRunner;
let chatRunner: AgentRunner;
let sandboxRunner: AgentRunner | undefined;
if (cfg.agentRunner === "fake") {
  runner = new FakeAgentRunner();
  chatRunner = new FakeAgentRunner({ usage: "delta" });
  sandboxRunner = new FakeAgentRunner();
} else {
  const client = new Anthropic({ apiKey: cfg.anthropicApiKey! });
  runner = new ClaudeAgentRunner(cfg.anthropicApiKey!, createPgSessionStore(handle.db));
  chatRunner = new ChatRunner(client);
  if (cfg.sandbox.mode === "managed") {
    sandboxRunner = new ManagedAgentRunner(client, {
      agentId: cfg.sandbox.agentId!,
      environmentId: cfg.sandbox.environmentId!,
      defaultCapUsd: cfg.sandbox.turnMaxBudgetUsd,
    });
  }
}

const { app, auth, chat } = await buildApp({ cfg, db: handle.db, runner, chatRunner, sandboxRunner, hasher: new PasswordHasher() });

if (!cfg.databaseUrl) app.log.warn("DATABASE_URL не задан - используется локальная встроенная БД (только для разработки).");
if (cfg.agentRunner === "fake") app.log.warn("AGENT_RUNNER=fake - вместо Claude отвечает заглушка. Для настоящей работы уберите эту переменную.");
app.log.info(
  cfg.sandbox.mode === "managed"
    ? "Терминал для подписчиков: песочница Anthropic Managed Agents."
    : "Терминал для публичных пользователей выключен (SANDBOX_MODE=off).",
);

if (cfg.ownerEmail && cfg.ownerPassword) {
  const created = await auth.bootstrapOwner(cfg.ownerEmail, cfg.ownerPassword);
  app.log.info(created ? `Создан владелец ${cfg.ownerEmail}.` : "Владелец уже существует (OWNER_PASSWORD можно удалить из переменных).");
} else {
  app.log.warn("OWNER_EMAIL/OWNER_PASSWORD не заданы - первый вход невозможен, пока владельца нет.");
}

// Раз в час: просроченные сессии входа, давние диалоги гостей, забытые песочницы.
async function housekeeping(): Promise<void> {
  await auth.purgeExpired();
  const guests = await auth.purgeGuests(cfg.guests.retentionDays);
  if (guests.conversations || guests.guests) app.log.info(guests, "убраны давние диалоги и гости");
  const sandboxes = await chat.purgeSandboxSessions();
  if (sandboxes) app.log.info({ sandboxes }, "освобождены давние сессии песочницы");
}
const purgeTimer = setInterval(() => {
  housekeeping().catch((error) => app.log.error(error));
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
