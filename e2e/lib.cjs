/* Общие помощники для сквозных тестов. Playwright берётся из глобальной установки (см. ~/.node_modules). */
const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PSQL = "C:\\Users\\user\\scoop\\apps\\postgresql\\current\\bin\\psql.exe";
const PG = { host: "127.0.0.1", port: "54329", user: "postgres" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sql(db, statement) {
  return execFileSync(PSQL, ["-h", PG.host, "-p", PG.port, "-U", PG.user, "-d", db, "-tAc", statement], { encoding: "utf8" }).trim();
}

function recreateDb(name) {
  sql("postgres", `drop database if exists ${name} with (force)`);
  sql("postgres", `create database ${name}`);
  return `postgres://${PG.user}@${PG.host}:${PG.port}/${name}`;
}

const children = [];

async function start(name, cwd, args, env, readyUrl, timeoutMs = 40000) {
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  const logs = [];
  child.stdout.on("data", (d) => logs.push(String(d)));
  child.stderr.on("data", (d) => logs.push(String(d)));
  children.push(child);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(readyUrl);
      if (response.ok) return { child, logs };
    } catch {
      /* ещё не поднялся */
    }
    if (child.exitCode !== null) throw new Error(`${name} завершился с кодом ${child.exitCode}:\n${logs.join("")}`);
    await sleep(200);
  }
  throw new Error(`${name} не запустился за ${timeoutMs} мс:\n${logs.join("")}`);
}

/** Останавливает один процесс и ждёт его завершения (нужно, чтобы порт освободился). */
async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill();
  for (let i = 0; i < 50 && child.exitCode === null; i++) await sleep(100);
}

function stopAll() {
  for (const child of children) {
    try {
      child.kill();
    } catch {
      /* уже остановлен */
    }
  }
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "  ✓" : "  ✗ ПРОВАЛ:"} ${name}${!ok && detail ? `  → ${detail}` : ""}`);
}
function summary() {
  const failed = results.filter((r) => !r.ok);
  console.log(`\nИтого: ${results.length - failed.length} из ${results.length} проверок пройдено.`);
  if (failed.length) {
    console.log("Провалены:");
    for (const f of failed) console.log(` - ${f.name} ${f.detail}`);
  }
  return failed.length === 0;
}

const shotsDir = path.join(os.tmpdir(), "entineq-e2e-shots");
fs.mkdirSync(shotsDir, { recursive: true });
const shot = async (page, name) => page.screenshot({ path: path.join(shotsDir, `${name}.png`), fullPage: false });

/** Следит за ошибками страницы: консоль, исключения, нарушения CSP, неудачные запросы. */
function watchPage(page, label, sink) {
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") sink.push(`[${label}] console.${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", (error) => sink.push(`[${label}] pageerror: ${error.message}`));
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "";
    // Отмена запроса при закрытии страницы не ошибка.
    if (!/ERR_ABORTED/.test(failure)) sink.push(`[${label}] requestfailed: ${request.url()} ${failure}`);
  });
}

module.exports = { sleep, sql, recreateDb, start, stop, stopAll, check, summary, shot, shotsDir, watchPage, PG };
