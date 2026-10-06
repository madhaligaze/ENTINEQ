/*
 * Сквозной тест интерфейса ENTINEQ_AGENT: настоящий браузер, настоящий Postgres, заглушка вместо Claude.
 * Поднимаются два сервиса: бэкенд (ENTINEQ_AGENT/backend) и фронтенд (ENTINEQ_AGENT/frontend), браузер ходит только на фронтенд.
 */
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright");
const { check, recreateDb, shot, sleep, start, stopAll, summary, watchPage } = require("./lib.cjs");

const APP = path.resolve(__dirname, "..", "ENTINEQ_AGENT");
const BACK_PORT = 18080;
const FRONT_PORT = 18082;
const BASE = `http://127.0.0.1:${FRONT_PORT}`;
const OWNER = { email: "owner@e2e.test", password: "owner-password-123" };
const problems = [];

(async () => {
  const databaseUrl = recreateDb("entineq_e2e_core");
  const dataDir = path.join(require("node:os").tmpdir(), "entineq-e2e-core-data");
  fs.rmSync(dataDir, { recursive: true, force: true });
  await start(
    "agent-backend",
    path.join(APP, "backend"),
    ["dist/server.js"],
    {
      NODE_ENV: "production",
      PORT: String(BACK_PORT),
      DATABASE_URL: databaseUrl,
      INTERNAL_API_SECRET: "e2e-internal-secret-0123456789abcdef0123456789",
      AGENT_RUNNER: "fake",
      OWNER_EMAIL: OWNER.email,
      OWNER_PASSWORD: OWNER.password,
      ALLOWED_ORIGINS: BASE,
      COOKIE_SECURE: "false",
      DATA_DIR: dataDir,
      LOG_LEVEL: "warn",
    },
    `http://127.0.0.1:${BACK_PORT}/healthz`,
  );
  await start(
    "agent-frontend",
    path.join(APP, "frontend"),
    ["dist/server.js"],
    {
      NODE_ENV: "production",
      PORT: String(FRONT_PORT),
      BACKEND_URL: `http://127.0.0.1:${BACK_PORT}`,
      TRUST_PROXY_HOPS: "0",
      LOG_LEVEL: "warn",
      RATE_LIMIT_AUTH_PER_MIN: "1000",
      RATE_LIMIT_WS_PER_MIN: "1000",
    },
    `${BASE}/healthz`,
  );

  const browser = await chromium.launch();
  try {
    /* ---------- 1. вход ---------- */
    console.log("\n[1] Вход");
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 820 }, locale: "ru-RU" });
    const page = await ctx.newPage();
    watchPage(page, "owner", problems);
    await page.goto(BASE);
    await page.waitForSelector("#login-view:not([hidden])");
    check("видна форма входа, остальное скрыто", (await page.isHidden("#app-view")) && (await page.isHidden("#boot-view")));
    await shot(page, "core-01-login");

    await page.fill("#login-email", OWNER.email);
    await page.fill("#login-password", "неверный-пароль-1");
    await page.click("#login-submit");
    await page.waitForSelector("#login-error:not([hidden])");
    check("неверный пароль: понятная ошибка", (await page.textContent("#login-error")) === "Неверный email или пароль.");
    check("после ошибки остаёмся на форме входа", await page.isVisible("#login-view"));

    await page.fill("#login-password", OWNER.password);
    await page.click("#login-submit");
    await page.waitForSelector("#app-view:not([hidden])");
    check("после входа показано приложение", await page.isVisible("#app-view"));
    check("email пользователя в шапке", (await page.textContent("#user-email")) === OWNER.email);
    check("вкладка «Админка» видна владельцу", await page.isVisible("#tab-admin"));
    check("пароль очищен из поля после входа", (await page.inputValue("#login-password")) === "");
    await page.waitForFunction(() => document.getElementById("status").textContent === "готов");
    check("статус соединения «готов»", true);
    check("окно ещё не начато", (await page.textContent("#usage-timer")).includes("первого сообщения"));
    check("у владельца нет лимита окна", (await page.textContent("#usage-window-line")).includes("без лимита"));

    /* ---------- 2. чат ---------- */
    console.log("\n[2] Чат");
    await page.fill("#input", "привет");
    await page.click("#send");
    await page.waitForFunction(() => [...document.querySelectorAll(".bubble.assistant")].some((b) => b.textContent === "Эхо: привет"));
    check("ответ ассистента отображён", true);
    check("сообщение пользователя отображено", (await page.locator(".bubble.user").first().textContent()) === "привет");
    await page.waitForFunction(() => document.getElementById("status").textContent === "готов" && !document.getElementById("send").disabled);
    check("после ответа ввод снова доступен", true);
    check("окно началось: идёт таймер", /Сброс через \d:\d\d:\d\d/.test(await page.textContent("#usage-timer")), await page.textContent("#usage-timer"));
    check("расход виден в панели", (await page.textContent("#usage-window-line")).includes("$0.01"), await page.textContent("#usage-window-line"));
    check("диалог появился в списке", (await page.locator("#conversation-list button").count()) === 1);

    const timer1 = await page.textContent("#usage-timer");
    await sleep(2200);
    check("таймер действительно идёт", (await page.textContent("#usage-timer")) !== timer1);

    await page.fill("#input", "[[bash]] запусти что-нибудь");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll(".bubble.assistant").length >= 2);
    check("Enter отправляет сообщение", true);
    check("вызов инструмента попал в панель терминала", (await page.locator("#terminal .line.cmd").first().textContent()) === "echo hello");

    await page.fill("#input", "строка1");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("строка2");
    check("Shift+Enter делает перенос строки, а не отправку", (await page.inputValue("#input")) === "строка1\nстрока2");
    await page.fill("#input", "");

    /* ---------- 3. безопасность вывода ---------- */
    console.log("\n[3] Безопасность вывода (XSS)");
    const payload = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script><b>жирный</b>`;
    await page.fill("#input", payload);
    await page.click("#send");
    await page.waitForFunction((p) => [...document.querySelectorAll(".bubble.assistant")].some((b) => b.textContent === `Эхо: ${p}`), payload);
    await sleep(300);
    check("разметка выведена как текст", (await page.locator(".bubble.assistant").last().textContent()) === `Эхо: ${payload}`);
    check("скрипт не выполнился", (await page.evaluate(() => window.__xss)) === undefined);
    check("в сообщениях нет лишних элементов", (await page.locator(".messages img, .messages script, .messages b").count()) === 0);
    await shot(page, "core-02-chat");

    /* ---------- 4. история ---------- */
    console.log("\n[4] История диалогов");
    await page.click("#new-chat");
    check("новый диалог очищает чат", (await page.locator(".bubble").count()) === 0 && (await page.locator(".hint").count()) === 1);
    check("новый диалог очищает терминал", (await page.locator("#terminal .line").count()) === 0);
    await page.locator("#conversation-list button").first().click();
    await page.waitForFunction(() => document.querySelectorAll(".bubble.user").length >= 3);
    check("история загружена из БД", (await page.locator(".bubble.user").count()) === 3);
    check("инструменты из истории вернулись в терминал", (await page.locator("#terminal .line.cmd").count()) === 1);

    /* ---------- 5. админка ---------- */
    console.log("\n[5] Админка");
    await page.click("#tab-admin");
    await page.waitForSelector("#admin-root table");
    check("таблица пользователей показана", (await page.locator("#admin-root section").first().locator("tbody tr").count()) >= 1);

    const trusted = { email: "friend@e2e.test", password: "friend-password-123" };
    const form = page.locator("#admin-root form").nth(0);
    await form.locator("input[type=email]").fill(trusted.email);
    await form.locator("input[type=password]").fill(trusted.password);
    await form.locator("select").selectOption("trusted");
    await form.locator("button[type=submit]").click();
    await page.waitForFunction((email) => [...document.querySelectorAll("#admin-root td")].some((td) => td.textContent === email), trusted.email);
    check("доверенный пользователь создан и виден в таблице", true);

    const dupForm = page.locator("#admin-root form").nth(0);
    await dupForm.locator("input[type=email]").fill(trusted.email);
    await dupForm.locator("input[type=password]").fill(trusted.password);
    await dupForm.locator("button[type=submit]").click();
    await page.waitForSelector(".notice.error:not([hidden])");
    check("повторный email: понятная ошибка", (await page.textContent(".notice.error")).includes("уже зарегистрирован"));

    const inviteForm = page.locator("#admin-root form").nth(1);
    await inviteForm.locator("input").first().fill("2");
    await inviteForm.locator("button[type=submit]").click();
    await page.waitForFunction(() => document.querySelector(".codes")?.value.includes("ENT-"));
    const codes = (await page.inputValue(".codes")).split("\n");
    check("созданы 2 кода приглашений", codes.length === 2 && codes.every((c) => /^ENT-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(c)), codes.join("|"));
    await page.waitForFunction(() => document.querySelectorAll("#admin-root table")[1]?.querySelectorAll("tbody tr").length >= 2);
    check("приглашения видны в списке без кодов", !(await page.locator("#admin-root").textContent()).includes(codes[0]));
    await page.locator("button", { hasText: "Отозвать" }).first().click();
    await page.waitForFunction(() => [...document.querySelectorAll(".badge")].some((b) => b.textContent === "отозвано"));
    check("приглашение отозвано", true);

    // Лимит окна доверенного → 0.01, чтобы проверить блокировку и таймер.
    const row = page.locator("#admin-root tbody tr", { hasText: trusted.email });
    await row.locator("input").nth(1).fill("0.01");
    await row.locator("button", { hasText: "Сохранить" }).click();
    await page.waitForFunction(() => document.querySelector(".notice:not(.error):not([hidden])")?.textContent.includes("Лимиты сохранены"));
    check("лимит окна сохранён", true);
    await shot(page, "core-03-admin");

    await page.click("#tab-chat");
    await page.click("#tab-admin");
    await page.waitForFunction(() => document.querySelectorAll("#admin-root table").length >= 3);
    check("отчёт по расходам показан", (await page.locator("#admin-root tfoot").textContent()).includes("Итого"));
    const [download] = await Promise.all([page.waitForEvent("download"), page.locator("button", { hasText: "Скачать CSV" }).click()]);
    const csv = fs.readFileSync(await download.path(), "utf8");
    check("CSV скачивается и содержит расходы владельца", csv.includes("owner@e2e.test") && csv.includes("ИТОГО"), csv.slice(0, 120));
    check("CSV с BOM для Excel", csv.charCodeAt(0) === 0xfeff);

    /* ---------- 6. лимит окна у доверенного ---------- */
    console.log("\n[6] Лимит окна: блокировка и таймер");
    const ctx2 = await browser.newContext({ viewport: { width: 1360, height: 820 }, locale: "ru-RU" });
    const friend = await ctx2.newPage();
    watchPage(friend, "friend", problems);
    await friend.goto(BASE);
    await friend.fill("#login-email", trusted.email);
    await friend.fill("#login-password", trusted.password);
    await friend.click("#login-submit");
    await friend.waitForSelector("#app-view:not([hidden])");
    check("доверенному вкладка «Админка» не показывается", await friend.isHidden("#tab-admin"));
    await friend.waitForFunction(() => document.getElementById("status").textContent === "готов");
    check("до первого сообщения баннера нет", await friend.isHidden("#banner"));
    check("лимит окна виден: $0.00 из $0.01", (await friend.textContent("#usage-window-line")) === "$0.00 из $0.01", await friend.textContent("#usage-window-line"));

    await friend.fill("#input", "первое");
    await friend.click("#send");
    await friend.waitForSelector("#banner:not([hidden])");
    const bannerText = await friend.textContent("#banner");
    check("лимит исчерпан: баннер с таймером", /Лимит сессии исчерпан.*Новое окно откроется через \d:\d\d:\d\d/.test(bannerText), bannerText);
    check("отправка заблокирована", await friend.isDisabled("#send"));
    check("в поле подсказка про лимит", (await friend.getAttribute("#input", "placeholder")).includes("Лимит исчерпан"));
    const b1 = await friend.textContent("#banner");
    await sleep(2200);
    check("таймер баннера идёт", (await friend.textContent("#banner")) !== b1);
    await shot(friend, "core-04-limit");

    await friend.reload();
    await friend.waitForSelector("#app-view:not([hidden])");
    await friend.waitForSelector("#banner:not([hidden])");
    check("после перезагрузки блокировка сохраняется", /Лимит сессии исчерпан/.test(await friend.textContent("#banner")));
    check("отправка по-прежнему заблокирована", await friend.isDisabled("#send"));

    /* ---------- 7. отключение пользователя ---------- */
    console.log("\n[7] Отключение пользователя в админке");
    await page.click("#tab-admin");
    await page.waitForSelector("#admin-root table");
    const row2 = page.locator("#admin-root tbody tr", { hasText: trusted.email });
    await row2.locator("button", { hasText: "Отключить" }).click();
    await page.waitForFunction((email) => [...document.querySelectorAll("#admin-root tr")].some((tr) => tr.textContent.includes(email) && tr.textContent.includes("отключён")), trusted.email);
    check("пользователь отключён", true);
    await friend.reload();
    await friend.waitForSelector("#login-view:not([hidden])");
    check("у отключённого пользователя сессия закрыта сразу", true);

    /* ---------- 8. выход ---------- */
    console.log("\n[8] Выход");
    await page.click("#logout");
    await page.waitForSelector("#login-view:not([hidden])");
    check("после выхода показан вход", await page.isVisible("#login-view"));
    await page.reload();
    await page.waitForSelector("#login-view:not([hidden])");
    check("после перезагрузки сессии нет", true);
    check("cookie сессии удалена", !(await ctx.cookies()).some((c) => c.name === "entineq_agent_session" && c.value));

    /* ---------- 9. узкий экран ---------- */
    console.log("\n[9] Телефон (390×800)");
    const ctx3 = await browser.newContext({ viewport: { width: 390, height: 800 }, locale: "ru-RU", isMobile: true });
    const phone = await ctx3.newPage();
    watchPage(phone, "phone", problems);
    await phone.goto(BASE);
    await phone.fill("#login-email", OWNER.email);
    await phone.fill("#login-password", OWNER.password);
    await phone.click("#login-submit");
    await phone.waitForSelector("#app-view:not([hidden])");
    await phone.waitForFunction(() => document.getElementById("status").textContent === "готов");
    check("нет горизонтальной прокрутки", await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
    check("кнопка «Диалоги» видна, боковая панель скрыта", (await phone.isVisible("#sidebar-toggle")) && !(await phone.evaluate(() => document.getElementById("sidebar").getBoundingClientRect().right > 20)));
    await phone.click("#sidebar-toggle");
    await sleep(350);
    check("панель диалогов открывается", await phone.evaluate(() => document.getElementById("sidebar").getBoundingClientRect().left >= -1));
    await shot(phone, "core-05-phone");
    await phone.locator("#conversation-list button").first().click();
    await sleep(350);
    check("после выбора диалога панель закрывается", await phone.evaluate(() => document.getElementById("sidebar").getBoundingClientRect().right <= 20));
    await phone.fill("#input", "с телефона");
    await phone.click("#send");
    await phone.waitForFunction(() => [...document.querySelectorAll(".bubble.assistant")].some((b) => b.textContent === "Эхо: с телефона"));
    check("чат работает на телефоне", true);

    /* ---------- итог по ошибкам браузера ---------- */
    console.log("\n[10] Ошибки в консоли браузера и нарушения CSP");
    // Сценарий сам провоцирует 401 (неверный пароль, закрытая сессия), 403 и 409 (дубликат email): это не дефекты.
    const relevant = problems.filter((p) => !/Failed to load resource: the server responded with a status of (401|403|409)/.test(p));
    check("в консоли нет ошибок и нарушений CSP", relevant.length === 0, relevant.slice(0, 5).join(" || "));
    if (problems.length !== relevant.length) console.log(`  (отфильтровано ожидаемых 401/403 в консоли: ${problems.length - relevant.length})`);
  } finally {
    await browser.close();
  }
})()
  .catch((error) => {
    check("сценарий не упал с исключением", false, String(error && error.stack ? error.stack : error));
  })
  .finally(() => {
    stopAll();
    const ok = summary();
    process.exit(ok ? 0 : 1);
  });
