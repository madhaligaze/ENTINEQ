import { buildApp } from "./app.js";
import { ConfigError, loadConfig, type Config } from "./config.js";
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
const app = await buildApp(cfg);
const host = await listen(app, cfg.port, cfg.host);
app.log.info(`Пересылаю /api и /ws на ${cfg.backendOrigin} (слушаю ${host}:${cfg.port}).`);

// Проверка связки при старте. Не фатальная: бэкенд может подняться позже, а сервис должен отвечать на /healthz.
fetch(`${cfg.backendOrigin}/healthz`, { signal: AbortSignal.timeout(5000) }).then(
  (response) => {
    if (!response.ok) app.log.warn(`Бэкенд ответил ${response.status} на /healthz. Проверьте BACKEND_URL.`);
  },
  () => app.log.warn(`Бэкенд пока недоступен (${cfg.backendOrigin}). Если он ещё запускается — это нормально; иначе проверьте BACKEND_URL.`),
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
