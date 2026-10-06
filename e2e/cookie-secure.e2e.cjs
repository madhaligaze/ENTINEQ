/* Как ведёт себя cookie с флагом Secure, когда боевой режим открывают по http://localhost (частый локальный запуск образа). */
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { chromium } = require("playwright");
const { check, recreateDb, start, stopAll, summary } = require("./lib.cjs");

const CORE_DIR = path.resolve(__dirname, "..", "ENTINEQ_AGENT");
const PORT = 18090;
const OWNER = { email: "owner@e2e.test", password: "owner-password-123" };

(async () => {
  const databaseUrl = recreateDb("entineq_e2e_cookie");
  const dataDir = path.join(os.tmpdir(), "entineq-e2e-cookie-data");
  fs.rmSync(dataDir, { recursive: true, force: true });
  await start(
    "core",
    CORE_DIR,
    ["dist/server.js"],
    {
      NODE_ENV: "production", // COOKIE_SECURE намеренно не задан: по умолчанию в production cookie получает флаг Secure
      PORT: String(PORT),
      DATABASE_URL: databaseUrl,
      INTERNAL_API_SECRET: "e2e-internal-secret-0123456789abcdef0123456789",
      AGENT_RUNNER: "fake",
      OWNER_EMAIL: OWNER.email,
      OWNER_PASSWORD: OWNER.password,
      DATA_DIR: dataDir,
      LOG_LEVEL: "error",
    },
    `http://127.0.0.1:${PORT}/healthz`,
  );
  const browser = await chromium.launch();
  try {
    for (const host of ["localhost", "127.0.0.1"]) {
      const ctx = await browser.newContext({ locale: "ru-RU" });
      const page = await ctx.newPage();
      await page.goto(`http://${host}:${PORT}`);
      await page.fill("#login-email", OWNER.email);
      await page.fill("#login-password", OWNER.password);
      await page.click("#login-submit");
      await page.waitForSelector("#app-view:not([hidden])");
      const cookie = (await ctx.cookies()).find((c) => c.name === "entineq_agent_session");
      await page.reload();
      await page.waitForSelector("#app-view:not([hidden]), #login-view:not([hidden])");
      const stillIn = await page.isVisible("#app-view");
      check(`http://${host}: cookie Secure принята браузером (secure=${cookie?.secure}), сессия переживает перезагрузку`, Boolean(cookie) && stillIn, `cookie=${Boolean(cookie)} stillIn=${stillIn}`);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
})()
  .catch((error) => check("сценарий не упал", false, String(error)))
  .finally(() => {
    stopAll();
    process.exit(summary() ? 0 : 1);
  });
