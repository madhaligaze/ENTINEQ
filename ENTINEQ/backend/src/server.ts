import { buildApp } from "./app.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
import { EXPECTED_CONTRACT } from "./contract.js";
import { AppError } from "./errors.js";
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
const { app, core } = await buildApp(cfg);

const host = await listen(app, cfg.port, cfg.host);
app.log.info(`Слушаю ${host}:${cfg.port}.`);

// Проверка связки при старте. Не фатальная: ядро может подняться позже, а приложение должно отвечать на /healthz.
core.ping().then(
  (ping) => {
    if (ping.contract !== EXPECTED_CONTRACT) {
      app.log.error({ expected: EXPECTED_CONTRACT, actual: ping.contract }, "версии контракта ENTINEQ и ENTINEQ_AGENT не совпадают — обновите оба проекта");
    } else {
      app.log.info(`Связь с ядром установлена (${cfg.agentOrigin}).`);
    }
  },
  (error: unknown) => {
    const reason = error instanceof AppError ? error.code : "unknown";
    app.log.warn(`Ядро пока недоступно (${cfg.agentOrigin}): ${reason}. Если оно ещё запускается — это нормально; иначе проверьте AGENT_BASE_URL и INTERNAL_API_SECRET.`);
  },
);

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  app.log.info({ signal }, "останавливаюсь");
  setTimeout(() => process.exit(1), 15_000).unref();
  try {
    await app.close();
  } catch (error) {
    app.log.error(error);
  }
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
