/*
 * Проверка связки в контейнерах (docker compose up): пять сервисов, как в Railway. Живой браузер ходит только на фронтенды,
 * бэкенды наружу не опубликованы. Плюс перезапуски бэкенда ядра (деплой новой версии) и самой базы данных.
 */
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { chromium } = require("playwright");
const { check, shot, sleep, summary, watchPage } = require("./lib.cjs");

const ROOT = path.resolve(__dirname, "..");
const CORE = "http://localhost:8080"; // фронтенд ENTINEQ_AGENT (запросы /api он пересылает бэкенду)
const PUB = "http://localhost:8081"; // фронтенд ENTINEQ
const OWNER = { email: "owner@example.com", password: "owner-password-123" };
const problems = [];

const compose = (...args) => execFileSync("docker", ["compose", ...args], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** Код ответа /readyz изнутри контейнера бэкенда (наружу бэкенды не опубликованы). */
function readyzInside(service) {
  try {
    const out = compose("exec", "-T", service, "node", "-e", "fetch('http://127.0.0.1:8080/readyz').then(r=>console.log(r.status)).catch(()=>console.log(0))");
    return Number(out.trim());
  } catch {
    return 0;
  }
}

async function http(base, method, url, { body, cookie } = {}) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* не JSON */
  }
  return { status: response.status, json, cookie: response.headers.getSetCookie().map((c) => c.split(";")[0]).find((c) => c.includes("=")) };
}

(async () => {
  const browser = await chromium.launch();
  try {
    console.log("\n[0] Топология");
    const ps = compose("ps", "--format", "{{.Service}}|{{.Ports}}").trim().split("\n");
    const published = (service) => (ps.find((line) => line.startsWith(`${service}|`)) ?? "").includes("->");
    check("пять сервисов запущены", ["db", "agent-backend", "agent-frontend", "public-backend", "public-frontend"].every((s) => ps.some((line) => line.startsWith(`${s}|`))), ps.join(" ; "));
    check("фронтенды опубликованы наружу", published("agent-frontend") && published("public-frontend"));
    check("бэкенды и база наружу не опубликованы (закрытый контур)", !published("agent-backend") && !published("public-backend") && !published("db"), ps.join(" ; "));
    check("бэкенд публичного приложения видит ядро (/readyz изнутри)", readyzInside("public-backend") === 200);

    console.log("\n[1] Связка в контейнерах");
    const login = await http(CORE, "POST", "/api/auth/login", { body: OWNER });
    check("владелец входит в ядро в контейнере", login.status === 200, JSON.stringify(login.json));
    const invite = (await http(CORE, "POST", "/api/admin/invites", { body: { count: 1 }, cookie: login.cookie })).json.invites[0].code;

    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "ru-RU" });
    const page = await ctx.newPage();
    watchPage(page, "user", problems);
    await page.goto(PUB);
    await page.click("#tab-register");
    await page.fill("#register-code", invite);
    await page.fill("#register-email", "dock@example.com");
    await page.fill("#register-password", "docker-password-123");
    await page.click("#register-submit");
    await page.waitForSelector("#app-view:not([hidden])");
    await page.waitForFunction(() => document.getElementById("status").textContent === "готов");
    check("регистрация и вход в публичное приложение в контейнере", true);
    await page.fill("#input", "привет из контейнера");
    await page.click("#send");
    await page.waitForFunction(() => [...document.querySelectorAll(".bubble.assistant")].some((b) => b.textContent === "Эхо: привет из контейнера"));
    check("ответ получен через цепочку браузер → public → agent → БД", true);
    await page.waitForFunction(() => document.querySelectorAll("#conversation-list button").length === 1);
    await shot(page, "docker-01-chat");

    console.log("\n[2] Перезапуск бэкенда ядра (деплой новой версии)");
    compose("restart", "agent-backend");
    await page.waitForFunction(() => document.getElementById("status").textContent !== "готов", null, { timeout: 15000 }).catch(() => {});
    await page.waitForFunction(() => document.getElementById("status").textContent === "готов" && !document.getElementById("send").disabled, null, { timeout: 60000 });
    check("интерфейс сам переподключился после перезапуска ядра", true);
    await page.fill("#input", "после перезапуска ядра");
    await page.click("#send");
    await page.waitForFunction(() => [...document.querySelectorAll(".bubble.assistant")].some((b) => b.textContent === "Эхо: после перезапуска ядра"), null, { timeout: 20000 });
    check("сессия пользователя пережила перезапуск (она хранится в БД)", true);
    await page.locator("#new-chat").click();
    await page.locator("#conversation-list button").first().click();
    await page.waitForFunction(() => document.querySelectorAll(".bubble.user").length >= 2);
    check("история диалога на месте после перезапуска", true);
    const usageText = await page.textContent("#usage-window-line");
    check("расход сохранился в БД: $0.02", usageText === "$0.02 из $1.00", usageText);

    console.log("\n[3] Перезапуск базы данных (обслуживание Postgres)");
    compose("restart", "db");
    await sleep(3000);
    let recovered = false;
    for (let attempt = 0; attempt < 20 && !recovered; attempt++) {
      // /readyz бэкенда ядра проверяет настоящий запрос к БД; бэкенд публичного - что ядро его видит.
      recovered = readyzInside("agent-backend") === 200 && readyzInside("public-backend") === 200;
      if (!recovered) await sleep(1500);
    }
    check("бэкенд ядра сам восстановил соединение с БД без перезапуска процесса", recovered);
    const stillUp = compose("ps", "--format", "{{.Service}} {{.Status}}");
    check("контейнеры бэкендов не падали", /agent-backend Up/.test(stillUp) && /public-backend Up/.test(stillUp) && !/Restarting|Exited/.test(stillUp), stillUp.replace(/\n/g, " | "));
    await page.reload();
    await page.waitForSelector("#app-view:not([hidden])", { timeout: 20000 });
    await page.waitForFunction(() => document.getElementById("status").textContent === "готов", null, { timeout: 20000 });
    await page.fill("#input", "после перезапуска БД");
    await page.click("#send");
    await page.waitForFunction(() => [...document.querySelectorAll(".bubble.assistant")].some((b) => b.textContent === "Эхо: после перезапуска БД"), null, { timeout: 20000 });
    check("после перезапуска БД пользователь по-прежнему залогинен и чат работает", true);

    console.log("\n[4] Логи");
    const logs = compose("logs", "--no-log-prefix", "agent-backend", "agent-frontend", "public-backend", "public-frontend");
    const errorLines = logs.split("\n").filter((l) => /"level":(50|60)/.test(l));
    check("в логах нет записей уровня error/fatal, кроме ожидаемых при перезапуске БД", errorLines.every((l) => /terminating connection|ECONNREFUSED|Connection terminated|57P01|database system is shutting down|ENOTFOUND|EAI_AGAIN/.test(l)), errorLines.slice(0, 3).join(" || ").slice(0, 500));
    check("секреты не попадали в логи", !logs.includes("local-dev-shared-secret") && !logs.includes("owner-password-123") && !logs.includes("docker-password-123"));
    const expected = /Failed to load resource: the server responded with a status of (401|502|503)|WebSocket connection to .* failed|ERR_CONNECTION_(REFUSED|RESET)|ERR_EMPTY_RESPONSE/;
    const relevant = problems.filter((p) => !expected.test(p));
    check("в консоли браузера нет неожиданных ошибок", relevant.length === 0, relevant.slice(0, 4).join(" || "));
  } finally {
    await browser.close();
  }
})()
  .catch((error) => check("сценарий не упал с исключением", false, String(error && error.stack ? error.stack : error)))
  .finally(() => process.exit(summary() ? 0 : 1));
