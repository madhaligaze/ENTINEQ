/*
 * Сквозной тест связки сервисов, как она будет в Railway: бэкенд ENTINEQ_AGENT (на настоящем Postgres) →
 * бэкенд публичного приложения ENTINEQ → его фронтенд, и настоящий браузер, который открывает только фронтенд.
 * Вместо Claude - заглушка (AGENT_RUNNER=fake), поэтому расходов нет.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const { check, recreateDb, shot, sleep, start, stop, stopAll, summary, watchPage } = require("./lib.cjs");

const ROOT = path.resolve(__dirname, "..");
const AGENT_BACK_PORT = 18080;
const PUB_BACK_PORT = 18081;
const PUB_FRONT_PORT = 18083;
const CORE = `http://127.0.0.1:${AGENT_BACK_PORT}`; // бэкенд ENTINEQ_AGENT (прямые вызовы владельца)
const PUB_API = `http://127.0.0.1:${PUB_BACK_PORT}`; // бэкенд ENTINEQ (прямые проверки)
const PUB = `http://127.0.0.1:${PUB_FRONT_PORT}`; // фронтенд ENTINEQ - то, что открывает браузер
const SECRET = "e2e-internal-secret-0123456789abcdef0123456789";
const OWNER = { email: "owner@e2e.test", password: "owner-password-123" };
const problems = [];
const leaks = []; // всё, что получила страница: тела ответов и кадры WebSocket

function coreEnv(databaseUrl, dataDir) {
  return {
    NODE_ENV: "production",
    PORT: String(AGENT_BACK_PORT),
    DATABASE_URL: databaseUrl,
    INTERNAL_API_SECRET: SECRET,
    AGENT_RUNNER: "fake",
    OWNER_EMAIL: OWNER.email,
    OWNER_PASSWORD: OWNER.password,
    ALLOWED_ORIGINS: "http://127.0.0.1:18082", // адрес фронтенда ENTINEQ_AGENT (в этом сценарии не поднимается)
    COOKIE_SECURE: "false",
    DATA_DIR: dataDir,
    LOG_LEVEL: "warn",
  };
}

async function http(base, method, url, { body, cookie, headers } = {}) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    /* не JSON */
  }
  const setCookie = response.headers.getSetCookie().map((c) => c.split(";")[0]);
  return { status: response.status, json, text, cookie: setCookie.find((c) => c.includes("=")) };
}

function trackLeaks(page) {
  page.on("response", async (response) => {
    if (!response.url().startsWith(PUB)) return;
    try {
      leaks.push(await response.text());
    } catch {
      /* тело недоступно (редирект и т.п.) */
    }
  });
  page.on("websocket", (ws) => {
    ws.on("framereceived", (frame) => leaks.push(String(frame.payload)));
    ws.on("framesent", (frame) => leaks.push(String(frame.payload)));
  });
}

(async () => {
  const databaseUrl = recreateDb("entineq_e2e_full");
  const dataDir = path.join(os.tmpdir(), "entineq-e2e-full-data");
  fs.rmSync(dataDir, { recursive: true, force: true });

  const startCore = () => start("agent-backend", path.join(ROOT, "ENTINEQ_AGENT", "backend"), ["dist/server.js"], coreEnv(databaseUrl, dataDir), `${CORE}/healthz`);
  let coreProc = (await startCore()).child;
  await start(
    "public-backend",
    path.join(ROOT, "ENTINEQ", "backend"),
    ["dist/server.js"],
    {
      NODE_ENV: "production",
      PORT: String(PUB_BACK_PORT),
      AGENT_BASE_URL: CORE,
      INTERNAL_API_SECRET: SECRET,
      ALLOWED_ORIGINS: PUB,
      COOKIE_SECURE: "false",
      LOG_LEVEL: "warn",
    },
    `${PUB_API}/healthz`,
  );
  await start(
    "public-frontend",
    path.join(ROOT, "ENTINEQ", "frontend"),
    ["dist/server.js"],
    {
      NODE_ENV: "production",
      PORT: String(PUB_FRONT_PORT),
      BACKEND_URL: PUB_API,
      TRUST_PROXY_HOPS: "0",
      LOG_LEVEL: "warn",
      RATE_LIMIT_AUTH_PER_MIN: "1000",
      RATE_LIMIT_WS_PER_MIN: "1000",
    },
    `${PUB}/healthz`,
  );

  // Владелец (через API ядра) заготавливает приглашения.
  const ownerLogin = await http(CORE, "POST", "/api/auth/login", { body: OWNER });
  const ownerCookie = ownerLogin.cookie;
  const invite = async (count = 1) => (await http(CORE, "POST", "/api/admin/invites", { body: { count }, cookie: ownerCookie })).json.invites.map((i) => i.code);
  const [inviteA, inviteB, inviteC] = await invite(3);

  const browser = await chromium.launch();
  try {
    /* ---------- 0. связка ---------- */
    console.log("\n[0] Связка сервисов");
    const ready = await http(PUB_API, "GET", "/readyz");
    check("бэкенд публичного приложения видит ядро (/readyz)", ready.status === 200 && ready.json.ok === true, ready.text);
    const readyFront = await http(PUB, "GET", "/readyz");
    check("фронтенд видит свой бэкенд (/readyz)", readyFront.status === 200 && readyFront.json.ok === true, readyFront.text);
    check("внутренний API ядра не проброшен через публичный адрес", (await http(PUB, "GET", "/internal/me")).status === 404);
    check("админский API ядра не проброшен через публичный адрес", (await http(PUB, "GET", "/api/admin/users")).status === 404);
    check("внутренняя дверь ядра закрыта без секрета", (await http(CORE, "GET", "/internal/me")).status === 401);
    const body = { email: "nobody@e2e.test", password: "password-12345" };
    const evil = await http(PUB_API, "POST", "/api/auth/login", { body, headers: { origin: "https://evil.example" } });
    check("бэкенд отклоняет запрос с чужого сайта (Origin)", evil.status === 403, evil.text);
    const good = await http(PUB_API, "POST", "/api/auth/login", { body, headers: { origin: PUB } });
    check("и принимает запрос с адреса своего фронтенда", good.status === 401 && good.json.error.code === "invalid_credentials", good.text);

    /* ---------- 1. регистрация ---------- */
    console.log("\n[1] Регистрация по приглашению");
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "ru-RU" });
    const page = await ctx.newPage();
    watchPage(page, "user", problems);
    trackLeaks(page);
    await page.goto(PUB);
    await page.waitForSelector("#auth-view:not([hidden])");
    check("видна форма входа, регистрация скрыта", (await page.isVisible("#login-form")) && (await page.isHidden("#register-form")));
    await shot(page, "pub-01-login");

    await page.click("#tab-register");
    check("вкладка «Регистрация» показывает форму", await page.isVisible("#register-form"));
    await page.click("#register-submit");
    check("пустая форма: подсказка", (await page.textContent("#register-error")) === "Заполните все поля.");

    const email = "ann@e2e.test";
    await page.fill("#register-code", inviteA);
    await page.fill("#register-email", email);
    await page.fill("#register-password", "short");
    await page.click("#register-submit");
    check("короткий пароль: подсказка без обращения к серверу", (await page.textContent("#register-error")) === "Пароль: минимум 10 символов.");

    await page.fill("#register-code", "ENT-ZZZZ-ZZZZ-ZZZZ");
    await page.fill("#register-password", "ann-password-123");
    await page.click("#register-submit");
    await page.waitForFunction(() => document.getElementById("register-error").textContent.includes("недействительно"));
    check("неверный код: понятная ошибка", true);
    check("после ошибки остаёмся на регистрации", await page.isVisible("#register-form"));
    await shot(page, "pub-02-register-error");

    // Код в «неряшливом» виде: другой регистр, пробелы вместо дефисов.
    await page.fill("#register-code", inviteA.toLowerCase().replaceAll("-", " "));
    await page.click("#register-submit");
    await page.waitForSelector("#app-view:not([hidden])");
    check("регистрация прошла, показано приложение", await page.isVisible("#app-view"));
    check("email в шапке", (await page.textContent("#user-email")) === email);
    await page.waitForFunction(() => document.getElementById("status").textContent === "готов");
    check("соединение установлено", true);
    check("лимит окна по умолчанию $1.00", (await page.textContent("#usage-window-line")) === "$0.00 из $1.00", await page.textContent("#usage-window-line"));
    check("месячный лимит по умолчанию $10.00", (await page.textContent("#usage-month-line")) === "Месяц: $0.00 из $10.00", await page.textContent("#usage-month-line"));
    check("окно ещё не начато", (await page.textContent("#usage-timer")).includes("первого сообщения"));
    check("токен сессии не виден скрипту страницы (httpOnly)", !(await page.evaluate(() => document.cookie)).includes("entineq_session"));
    check("cookie сессии выставлена браузеру", (await ctx.cookies()).some((c) => c.name === "entineq_session" && c.httpOnly));
    check("у публичного пользователя нет панели терминала и админки", (await page.locator("#terminal, #tab-admin").count()) === 0);

    const ctxReuse = await browser.newContext({ locale: "ru-RU" });
    const reuse = await ctxReuse.newPage();
    watchPage(reuse, "reuse", problems);
    await reuse.goto(PUB);
    await reuse.click("#tab-register");
    await reuse.fill("#register-code", inviteA);
    await reuse.fill("#register-email", "other@e2e.test");
    await reuse.fill("#register-password", "other-password-123");
    await reuse.click("#register-submit");
    await reuse.waitForFunction(() => document.getElementById("register-error").textContent.includes("недействительно"));
    check("использованное приглашение повторно не работает", true);
    await ctxReuse.close();

    /* ---------- 2. чат ---------- */
    console.log("\n[2] Чат");
    await page.fill("#input", "привет");
    await page.click("#send");
    await page.waitForFunction(() => [...document.querySelectorAll(".bubble.assistant")].some((b) => b.textContent === "Эхо: привет"));
    check("ответ ассистента получен через цепочку браузер → ENTINEQ → ENTINEQ_AGENT", true);
    await page.waitForFunction(() => !document.getElementById("send").disabled);
    check("после ответа ввод доступен", true);
    check("расход виден: $0.01 из $1.00", (await page.textContent("#usage-window-line")) === "$0.01 из $1.00", await page.textContent("#usage-window-line"));
    check("пошёл таймер окна", /Сброс через [45]:\d\d:\d\d/.test(await page.textContent("#usage-timer")), await page.textContent("#usage-timer"));
    await page.waitForFunction(() => document.querySelectorAll("#conversation-list button").length === 1);
    check("диалог появился в списке", true);

    await page.fill("#input", "[[bash]] выполни команду");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => [...document.querySelectorAll(".bubble.assistant")].some((b) => b.textContent === "Эхо: [[bash]] выполни команду"));
    check("публичному пользователю инструменты не выдаются (нет вызова терминала)", (await page.locator(".bubble.tool").count()) === 0);

    const payload = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>`;
    await page.fill("#input", payload);
    await page.click("#send");
    await page.waitForFunction((p) => [...document.querySelectorAll(".bubble.assistant")].some((b) => b.textContent === `Эхо: ${p}`), payload);
    await sleep(300);
    check("разметка выведена как текст, скрипт не выполнился", (await page.evaluate(() => window.__xss)) === undefined && (await page.locator(".messages img, .messages script").count()) === 0);
    await shot(page, "pub-03-chat");

    await page.click("#new-chat");
    check("новый диалог очищает чат", (await page.locator(".bubble").count()) === 0);
    await page.locator("#conversation-list button").first().click();
    await page.waitForFunction(() => document.querySelectorAll(".bubble.user").length >= 3);
    check("история диалога загружена", (await page.locator(".bubble.user").count()) === 3);

    /* ---------- 3. выход и вход ---------- */
    console.log("\n[3] Выход и вход");
    await page.click("#logout");
    await page.waitForSelector("#auth-view:not([hidden])");
    check("после выхода показан вход", true);
    await page.reload();
    await page.waitForSelector("#auth-view:not([hidden])");
    check("после перезагрузки сессии нет", true);
    check("cookie сессии удалена", !(await ctx.cookies()).some((c) => c.name === "entineq_session" && c.value));

    await page.fill("#login-email", email);
    await page.fill("#login-password", "неверный-пароль-1");
    await page.click("#login-submit");
    await page.waitForFunction(() => document.getElementById("login-error").textContent === "Неверный email или пароль.");
    check("неверный пароль: понятная ошибка", true);
    await page.fill("#login-password", "ann-password-123");
    await page.click("#login-submit");
    await page.waitForSelector("#app-view:not([hidden])");
    await page.waitForFunction(() => document.querySelectorAll("#conversation-list button").length === 1);
    check("после входа история на месте", true);
    check("расход сохранился между входами", (await page.textContent("#usage-window-line")) === "$0.03 из $1.00", await page.textContent("#usage-window-line"));

    /* ---------- 4. лимит окна ---------- */
    console.log("\n[4] Лимит окна: блокировка и таймер");
    await page.click("#new-chat");
    await page.fill("#input", "[[expensive]] дорогой запрос");
    await page.click("#send");
    await page.waitForSelector("#banner:not([hidden])");
    await page.waitForFunction(() => /Лимит сессии исчерпан/.test(document.getElementById("banner").textContent));
    const banner = await page.textContent("#banner");
    check("лимит исчерпан: баннер с обратным отсчётом", /Новое окно откроется через \d:\d\d:\d\d/.test(banner), banner);
    check("отправка заблокирована", await page.isDisabled("#send"));
    check("сообщение об ошибке осталось в переписке", (await page.locator(".bubble.system").count()) >= 1);
    const t1 = await page.textContent("#banner");
    await sleep(2200);
    check("таймер идёт", (await page.textContent("#banner")) !== t1);
    await shot(page, "pub-04-limit");
    await page.reload();
    await page.waitForSelector("#banner:not([hidden])");
    check("после перезагрузки блокировка сохраняется", (await page.isDisabled("#send")) && /Лимит сессии исчерпан/.test(await page.textContent("#banner")));

    /* ---------- 5. двери ---------- */
    console.log("\n[5] Изоляция дверей");
    const viaCore = await http(CORE, "POST", "/api/auth/login", { body: { email, password: "ann-password-123" } });
    check("публичный аккаунт не входит в собственный интерфейс ядра", viaCore.status === 401);
    const pubCookie = (await ctx.cookies()).find((c) => c.name === "entineq_session").value;
    const asCoreCookie = await http(CORE, "GET", "/api/me", { cookie: `entineq_agent_session=${pubCookie}` });
    check("токен публичного пользователя не подходит к двери доверенных", asCoreCookie.status === 401);
    const asInternal = await http(CORE, "GET", "/internal/me", { headers: { "x-user-token": pubCookie } });
    check("токен не работает без секрета", asInternal.status === 401);
    const ownerAsPublic = await http(PUB, "POST", "/api/auth/login", { body: OWNER });
    check("владелец не входит через публичное приложение", ownerAsPublic.status === 401 && ownerAsPublic.json.error.code === "invalid_credentials");

    /* ---------- 6. отключение ---------- */
    console.log("\n[6] Отключение пользователя владельцем");
    const ctxB = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "ru-RU" });
    const bob = await ctxB.newPage();
    watchPage(bob, "bob", problems);
    trackLeaks(bob);
    await bob.goto(PUB);
    await bob.click("#tab-register");
    await bob.fill("#register-code", inviteB);
    await bob.fill("#register-email", "bob@e2e.test");
    await bob.fill("#register-password", "bob-password-123");
    await bob.click("#register-submit");
    await bob.waitForSelector("#app-view:not([hidden])");
    await bob.waitForFunction(() => document.getElementById("status").textContent === "готов");
    await bob.fill("#input", "я ещё здесь");
    await bob.click("#send");
    await bob.waitForFunction(() => [...document.querySelectorAll(".bubble.assistant")].some((b) => b.textContent === "Эхо: я ещё здесь"));
    const users = (await http(CORE, "GET", "/api/admin/users", { cookie: ownerCookie })).json.users;
    const bobId = users.find((u) => u.email === "bob@e2e.test").id;
    const disabled = await http(CORE, "PATCH", `/api/admin/users/${bobId}`, { body: { isActive: false }, cookie: ownerCookie });
    check("владелец отключил пользователя", disabled.status === 200);
    await bob.fill("#input", "а меня отключили?");
    await bob.click("#send");
    await bob.waitForSelector("#auth-view:not([hidden])");
    check("отключённый пользователь возвращён на вход", true);
    check("с понятным объяснением", (await bob.textContent("#login-error")).includes("Сессия закончилась"));
    await bob.fill("#login-email", "bob@e2e.test");
    await bob.fill("#login-password", "bob-password-123");
    await bob.click("#login-submit");
    await bob.waitForFunction(() => document.getElementById("login-error").textContent.includes("отключён"));
    check("повторный вход: «Аккаунт отключён»", true);
    await ctxB.close();

    /* ---------- 7. сбой ядра ---------- */
    console.log("\n[7] Ядро недоступно и возвращается");
    const ctxC = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "ru-RU" });
    const carol = await ctxC.newPage();
    watchPage(carol, "carol", problems);
    trackLeaks(carol);
    await carol.goto(PUB);
    await carol.click("#tab-register");
    await carol.fill("#register-code", inviteC);
    await carol.fill("#register-email", "carol@e2e.test");
    await carol.fill("#register-password", "carol-password-123");
    await carol.click("#register-submit");
    await carol.waitForSelector("#app-view:not([hidden])");
    await carol.waitForFunction(() => document.getElementById("status").textContent === "готов");
    check("до сбоя всё работает", true);

    await stop(coreProc);
    await carol.waitForFunction(() => document.getElementById("status").textContent !== "готов", null, { timeout: 15000 });
    check("при падении ядра интерфейс замечает потерю связи", true);
    check("отправка недоступна, пока связи нет", await carol.isDisabled("#send"));
    const bubblesDuringOutage = await carol.locator(".bubble.system").count();
    await sleep(6000);
    check("во время простоя чат не засоряется одинаковыми ошибками", (await carol.locator(".bubble.system").count()) === bubblesDuringOutage, `было ${bubblesDuringOutage}, стало ${await carol.locator(".bubble.system").count()}`);
    check("сам публичный сервер остаётся живым", (await http(PUB, "GET", "/healthz")).status === 200);
    const readyDuring = await http(PUB_API, "GET", "/readyz");
    check("/readyz бэкенда честно сообщает, что ядра нет", readyDuring.status === 503 && readyDuring.json.reason === "upstream_unavailable", readyDuring.text);
    check("фронтенд и бэкенд публичного приложения при этом живы", (await http(PUB, "GET", "/readyz")).status === 200 && (await http(PUB_API, "GET", "/healthz")).status === 200);
    await shot(carol, "pub-05-outage");

    coreProc = (await startCore()).child;
    await carol.waitForFunction(() => document.getElementById("status").textContent === "готов" && !document.getElementById("send").disabled, null, { timeout: 40000 });
    check("после возвращения ядра интерфейс сам переподключился", true);
    await carol.fill("#input", "я снова на связи");
    await carol.click("#send");
    await carol.waitForFunction(() => [...document.querySelectorAll(".bubble.assistant")].some((b) => b.textContent === "Эхо: я снова на связи"), null, { timeout: 15000 });
    check("после восстановления чат работает, сессия сохранилась", true);
    check("/readyz бэкенда снова зелёный", (await http(PUB_API, "GET", "/readyz")).status === 200);
    await ctxC.close();

    /* ---------- 8. утечки ---------- */
    console.log("\n[8] Утечки секретов в браузер");
    const tokens = (await ctx.cookies()).map((c) => c.value).filter((v) => v && v.length > 30);
    const dump = leaks.join("\n");
    check("внутренний секрет не попадал ни в один ответ и кадр WebSocket", !dump.includes(SECRET));
    check("токен сессии не попадал в тела ответов и кадры", tokens.every((t) => !dump.includes(t)));
    check("в ответах нет хешей паролей", !/scrypt\$/.test(dump));
    check("собрано достаточно данных для проверки", leaks.length > 20, `ответов и кадров: ${leaks.length}`);

    /* ---------- 9. вид ---------- */
    console.log("\n[9] Телефон и светлая тема");
    const ctxPhone = await browser.newContext({ viewport: { width: 390, height: 800 }, locale: "ru-RU", isMobile: true, colorScheme: "light" });
    const phone = await ctxPhone.newPage();
    watchPage(phone, "phone", problems);
    await phone.goto(PUB);
    await phone.fill("#login-email", email);
    await phone.fill("#login-password", "ann-password-123");
    await phone.click("#login-submit");
    await phone.waitForSelector("#app-view:not([hidden])");
    await phone.waitForFunction(() => document.getElementById("status").textContent === "готов");
    check("нет горизонтальной прокрутки на телефоне", await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    check("светлая тема применяется", (await phone.evaluate(() => getComputedStyle(document.body).backgroundColor)) === "rgb(245, 245, 243)");
    await phone.click("#sidebar-toggle");
    await sleep(350);
    await shot(phone, "pub-06-phone-light");
    check("боковая панель открывается", await phone.evaluate(() => document.getElementById("sidebar").getBoundingClientRect().left >= -1));
    await ctxPhone.close();

    /* ---------- 10. консоль ---------- */
    console.log("\n[10] Консоль браузера");
    const expected = /Failed to load resource: the server responded with a status of (400|401|403|404|409|423|502|503)|WebSocket connection to .* failed|ERR_CONNECTION_REFUSED/;
    const relevant = problems.filter((p) => !expected.test(p));
    check("нет неожиданных ошибок и предупреждений", relevant.length === 0, relevant.slice(0, 6).join(" || "));
    check("нет нарушений политики безопасности (CSP)", !problems.some((p) => /Content Security Policy|Refused to/i.test(p)), problems.filter((p) => /Content Security/i.test(p)).join(" || "));
    check("нет необработанных исключений на страницах", !problems.some((p) => /pageerror/.test(p)), problems.filter((p) => /pageerror/.test(p)).join(" || "));
    console.log(`  (ожидаемых сообщений браузера об ошибках запросов: ${problems.length - relevant.length})`);
  } finally {
    await browser.close();
  }
})()
  .catch((error) => check("сценарий не упал с исключением", false, String(error && error.stack ? error.stack : error)))
  .finally(() => {
    stopAll();
    process.exit(summary() ? 0 : 1);
  });
