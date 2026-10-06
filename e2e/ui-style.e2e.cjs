/*
 * Проверка оформления по правилам из CLAUDE.md, в настоящем браузере и по вычисленным стилям (getComputedStyle),
 * а не на глаз: оба фронтенда, тёмная и светлая тема, ширины 1440 / 800 / 390.
 *
 * Что проверяется на каждом экране:
 *   - ни у одного элемента нет скругления углов (кнопки не пилюли, поля и плашки прямоугольные);
 *   - ни у одного элемента нет зелёного цвета (цвет только для отказа);
 *   - нет горизонтальной прокрутки страницы;
 *   - видимость основных элементов по ширине (боковая панель, кнопка меню, панель терминала, поле ввода и кнопка отправки);
 *   - контраст текста с фоном не ниже 4.5;
 *   - выбранное (вкладка, диалог) отличается весом подписи.
 * Состояния: вход и регистрация, чат с исчерпанным лимитом (баннер, красная полоса), админка владельца.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const { check, recreateDb, shot, sleep, start, stopAll, summary } = require("./lib.cjs");

const ROOT = path.resolve(__dirname, "..");
const P = { aBack: 18110, aFront: 18111, pBack: 18112, pFront: 18113 };
const A_FRONT = `http://127.0.0.1:${P.aFront}`;
const P_FRONT = `http://127.0.0.1:${P.pFront}`;
const A_BACK = `http://127.0.0.1:${P.aBack}`;
const SECRET = "ui-style-secret-0123456789abcdef0123456789";
const OWNER = { email: "owner@ui.test", password: "owner-password-123" };
const SCHEMES = ["dark", "light"];
const WIDTHS = [1440, 800, 390];

async function api(base, method, url, { body, cookie } = {}) {
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

/** Проверка внутри страницы: возвращает всё, что нашла, одним объектом. */
function pageAudit() {
  const parse = (value) => {
    const m = /rgba?\(([^)]+)\)/.exec(value);
    if (!m) return null;
    const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const label = (el) => `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).join(".") : ""}`;
  const isGreen = (c) => c && c.a > 0.3 && c.g >= 80 && c.g - c.r >= 25 && c.g - c.b >= 25;
  const visible = (el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return cs.display !== "none" && cs.visibility !== "hidden" && r.width > 0 && r.height > 0;
  };
  const effectiveBg = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.5) return c;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const lum = (c) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const ratio = (a, b) => {
    const [hi, lo] = lum(a) >= lum(b) ? [a, b] : [b, a];
    return (lum(hi) + 0.05) / (lum(lo) + 0.05);
  };

  const out = { radius: [], green: [], overflow: false, contrast: [], weights: {}, boxes: {} };
  for (const el of document.querySelectorAll("body *")) {
    const cs = getComputedStyle(el);
    if (cs.display === "none") continue;
    const radii = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomLeftRadius, cs.borderBottomRightRadius];
    if (radii.some((r) => r !== "0px")) out.radius.push(`${label(el)} ${radii.join("/")}`);
    const colored = [["color", cs.color], ["background", cs.backgroundColor]];
    for (const side of ["Top", "Right", "Bottom", "Left"]) if (parseFloat(cs[`border${side}Width`]) > 0 && cs[`border${side}Style`] !== "none") colored.push([`border${side}`, cs[`border${side}Color`]]);
    if (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) colored.push(["outline", cs.outlineColor]);
    for (const [what, value] of colored) if (isGreen(parse(value))) out.green.push(`${label(el)} ${what}=${value}`);
  }
  out.overflow = document.documentElement.scrollWidth > window.innerWidth + 1;

  const probe = [
    "#status", ".usage-line", ".usage-title", ".bubble.user", ".bubble.assistant", ".bubble.system.error", "button.primary", ".banner",
    ".topbar button", ".conversations button", ".conversations button.active", ".tab.active", ".tab:not(.active)", ".segmented button",
    "th", "td", ".badge", ".badge.off", ".notice", "label", ".muted", ".hint", ".error", ".terminal .line", "input", "textarea",
  ];
  for (const selector of probe) {
    const el = [...document.querySelectorAll(selector)].find((n) => visible(n) && (n.textContent || n.value || n.placeholder));
    if (!el) continue;
    const cs = getComputedStyle(el);
    const fg = parse(cs.color);
    if (!fg) continue;
    const need = 4.5;
    const got = ratio(fg, effectiveBg(el));
    if (got < need) out.contrast.push(`${selector}: ${got.toFixed(2)} (${cs.color} на ${getComputedStyle(el).backgroundColor})`);
  }

  const w = (selector) => {
    const el = document.querySelector(selector);
    return el ? parseInt(getComputedStyle(el).fontWeight, 10) : null;
  };
  out.weights = { tabActive: w(".tab.active"), tabIdle: w(".tab:not(.active)"), convActive: w(".conversations button.active"), convIdle: w(".conversations button:not(.active)"), segActive: w('.segmented button[aria-selected="true"]'), segIdle: w('.segmented button[aria-selected="false"]') };
  const box = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { shown: visible(el), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
  };
  out.boxes = { sidebar: box("#sidebar"), toggle: box("#sidebar-toggle"), terminal: box(".terminal-panel"), input: box("#input"), send: box("#send"), banner: box("#banner"), viewport: window.innerWidth };
  return out;
}

/** Правила видимости по ширине и наличию элементов; возвращает список нарушений. */
function visibilityProblems(frontend, width, a) {
  const bad = [];
  const b = a.boxes;
  if (!b.input || !b.send) return bad; // экран без чата (вход, админка)
  if (!b.input.shown || b.input.left < 0 || b.input.right > width + 1) bad.push("поле ввода не помещается");
  if (!b.send.shown || b.send.left < 0 || b.send.right > width + 1) bad.push("кнопка отправки не помещается");
  const narrow = frontend === "agent" ? width <= 720 : width <= 760;
  if (narrow) {
    if (!b.toggle?.shown) bad.push("нет кнопки меню на узком экране");
    if (b.sidebar && b.sidebar.right > 20) bad.push("боковая панель не спрятана на узком экране");
  } else {
    if (b.toggle?.shown) bad.push("кнопка меню видна на широком экране");
    if (!b.sidebar?.shown || b.sidebar.left < 0) bad.push("боковая панель не видна на широком экране");
  }
  if (frontend === "agent") {
    const wide = width > 1100;
    if (wide && !b.terminal?.shown) bad.push("панель терминала не видна на широком экране");
    if (!wide && b.terminal?.shown) bad.push("панель терминала не спрятана на среднем и узком экране");
  }
  return bad;
}

function report(name, a, extra = []) {
  const problems = [];
  if (a.radius.length) problems.push(`скругления: ${a.radius.slice(0, 4).join("; ")}`);
  if (a.green.length) problems.push(`зелёный: ${a.green.slice(0, 4).join("; ")}`);
  if (a.overflow) problems.push("горизонтальная прокрутка страницы");
  if (a.contrast.length) problems.push(`контраст: ${a.contrast.slice(0, 4).join("; ")}`);
  for (const [what, active, idle] of [["вкладки", a.weights.tabActive, a.weights.tabIdle], ["диалоги", a.weights.convActive, a.weights.convIdle], ["вход/регистрация", a.weights.segActive, a.weights.segIdle]]) {
    if (active !== null && idle !== null && !(active > idle)) problems.push(`выбранное не отличается весом (${what}: ${active} против ${idle})`);
  }
  problems.push(...extra);
  check(name, problems.length === 0, problems.join(" | "));
}

(async () => {
  const databaseUrl = recreateDb("entineq_ui_style");
  const dataDir = path.join(os.tmpdir(), "entineq-ui-style-data");
  fs.rmSync(dataDir, { recursive: true, force: true });

  await start(
    "agent-backend",
    path.join(ROOT, "ENTINEQ_AGENT", "backend"),
    ["dist/server.js"],
    {
      NODE_ENV: "production",
      PORT: String(P.aBack),
      DATABASE_URL: databaseUrl,
      INTERNAL_API_SECRET: SECRET,
      AGENT_RUNNER: "fake",
      OWNER_EMAIL: OWNER.email,
      OWNER_PASSWORD: OWNER.password,
      ALLOWED_ORIGINS: A_FRONT,
      COOKIE_SECURE: "false",
      DATA_DIR: dataDir,
      LOG_LEVEL: "warn",
      RATE_LIMIT_LOGIN_PER_MIN: "100000",
      RATE_LIMIT_WS_PER_MIN: "100000",
    },
    `${A_BACK}/healthz`,
  );
  await start("agent-frontend", path.join(ROOT, "ENTINEQ_AGENT", "frontend"), ["dist/server.js"], { NODE_ENV: "production", PORT: String(P.aFront), BACKEND_URL: A_BACK, TRUST_PROXY_HOPS: "0", LOG_LEVEL: "warn", RATE_LIMIT_AUTH_PER_MIN: "100000", RATE_LIMIT_WS_PER_MIN: "100000" }, `${A_FRONT}/healthz`);
  await start(
    "public-backend",
    path.join(ROOT, "ENTINEQ", "backend"),
    ["dist/server.js"],
    { NODE_ENV: "production", PORT: String(P.pBack), AGENT_BASE_URL: A_BACK, INTERNAL_API_SECRET: SECRET, ALLOWED_ORIGINS: P_FRONT, COOKIE_SECURE: "false", LOG_LEVEL: "warn", RATE_LIMIT_AUTH_PER_MIN: "100000", RATE_LIMIT_WS_PER_MIN: "100000" },
    `http://127.0.0.1:${P.pBack}/healthz`,
  );
  await start("public-frontend", path.join(ROOT, "ENTINEQ", "frontend"), ["dist/server.js"], { NODE_ENV: "production", PORT: String(P.pFront), BACKEND_URL: `http://127.0.0.1:${P.pBack}`, TRUST_PROXY_HOPS: "0", LOG_LEVEL: "warn", RATE_LIMIT_AUTH_PER_MIN: "100000", RATE_LIMIT_WS_PER_MIN: "100000" }, `${P_FRONT}/healthz`);

  const ownerLogin = await api(A_BACK, "POST", "/api/auth/login", { body: OWNER });
  const ownerCookie = ownerLogin.cookie;
  let seq = 0;
  const trustedLimited = async () => {
    const email = `limited${++seq}@ui.test`;
    const r = await api(A_BACK, "POST", "/api/admin/users", { body: { email, password: "limited-password-123", role: "trusted", windowLimitUsd: 0.01, monthlyBudgetUsd: null }, cookie: ownerCookie });
    if (r.status !== 201) throw new Error("не создан пользователь: " + JSON.stringify(r.json));
    return { email, password: "limited-password-123" };
  };
  const inviteLimited = async () => (await api(A_BACK, "POST", "/api/admin/invites", { body: { count: 1, windowLimitUsd: 0.01, monthlyBudgetUsd: null }, cookie: ownerCookie })).json.invites[0].code;
  // Для админки: пользователь с отключённым аккаунтом, чтобы в таблице была красная плашка «отключён».
  const disabled = await api(A_BACK, "POST", "/api/admin/users", { body: { email: "disabled@ui.test", password: "disabled-password-1", role: "public" }, cookie: ownerCookie });
  await api(A_BACK, "PATCH", `/api/admin/users/${disabled.json.user.id}`, { body: { isActive: false }, cookie: ownerCookie });

  const browser = await chromium.launch();
  try {
    /* ---------- самопроверка: аудит обязан ловить нарушения, иначе зелёные галочки ничего не значат ---------- */
    console.log("\n=== самопроверка аудита ===");
    {
      // CSP страницы запрещает встроенные стили (так и задумано), поэтому только здесь она отключена, чтобы подсунуть нарушения.
      const ctx = await browser.newContext({ viewport: { width: 1000, height: 700 }, colorScheme: "dark", bypassCSP: true });
      const page = await ctx.newPage();
      await page.goto(A_FRONT);
      await page.waitForSelector("#login-view:not([hidden])");
      await page.addStyleTag({
        content: "button{border-radius:12px} p.muted{color:#3cb371} .card{background:#2ecc71} body{min-width:2400px} label{color:#33363c}",
      });
      const bad = await page.evaluate(pageAudit);
      check("аудит находит скругления", bad.radius.length > 0, JSON.stringify(bad.radius.slice(0, 2)));
      check("аудит находит зелёный цвет (текст и фон)", bad.green.length >= 2, JSON.stringify(bad.green.slice(0, 3)));
      check("аудит находит горизонтальную прокрутку", bad.overflow === true);
      check("аудит находит слабый контраст", bad.contrast.length > 0, JSON.stringify(bad.contrast.slice(0, 2)));
      await ctx.close();
    }

    for (const scheme of SCHEMES) {
      for (const width of WIDTHS) {
        const tag = `${scheme} ${width}`;
        console.log(`\n=== ${tag} ===`);
        const newPage = async () => {
          const ctx = await browser.newContext({ viewport: { width, height: 800 }, colorScheme: scheme, locale: "ru-RU", isMobile: width < 500 });
          return { ctx, page: await ctx.newPage() };
        };

        /* ---------- ENTINEQ_AGENT ---------- */
        {
          const { ctx, page } = await newPage();
          await page.goto(A_FRONT);
          await page.waitForSelector("#login-view:not([hidden])");
          report(`[agent ${tag}] экран входа`, await page.evaluate(pageAudit));
          check(`[agent ${tag}] цвет фона соответствует теме`, (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === (scheme === "dark" ? "rgb(13, 14, 16)" : "rgb(245, 245, 243)"));

          const user = await trustedLimited();
          await page.fill("#login-email", user.email);
          await page.fill("#login-password", user.password);
          await page.click("#login-submit");
          await page.waitForSelector("#app-view:not([hidden])");
          await page.waitForFunction(() => document.getElementById("status").textContent === "готов");
          await page.fill("#input", "[[bash]] проверка оформления");
          await page.click("#send");
          await page.waitForSelector("#banner:not([hidden])");
          await page.waitForFunction(() => !document.getElementById("send").disabled || document.getElementById("send").disabled);
          await sleep(350);
          let a = await page.evaluate(pageAudit);
          const extra = visibilityProblems("agent", width, a);
          if (!(await page.evaluate(() => document.getElementById("usage-bar-fill").classList.contains("danger")))) extra.push("полоса лимита не красная при исчерпанном лимите");
          const fillBg = await page.evaluate(() => getComputedStyle(document.getElementById("usage-bar-fill")).backgroundColor);
          if (fillBg !== (scheme === "dark" ? "rgb(255, 107, 107)" : "rgb(198, 40, 40)")) extra.push(`цвет красной полосы ${fillBg}`);
          report(`[agent ${tag}] чат, лимит исчерпан (баннер, красная полоса)`, a, extra);
          await shot(page, `ui-agent-chat-${scheme}-${width}`);

          if (width <= 720) {
            await page.click("#sidebar-toggle");
            await sleep(350);
            a = await page.evaluate(pageAudit);
            const opened = a.boxes.sidebar && a.boxes.sidebar.left >= -1;
            report(`[agent ${tag}] боковая панель открыта`, a, opened ? [] : ["панель не открылась по кнопке меню"]);
          }
          await ctx.close();
        }
        {
          const { ctx, page } = await newPage();
          await page.goto(A_FRONT);
          await page.fill("#login-email", OWNER.email);
          await page.fill("#login-password", OWNER.password);
          await page.click("#login-submit");
          await page.waitForSelector("#app-view:not([hidden])");
          await page.click("#tab-admin");
          // Таблицы: пользователи и отчёт (таблица приглашений появляется, только когда они есть).
          await page.waitForFunction(() => document.querySelectorAll("#admin-root table").length >= 2);
          await page.waitForFunction(() => [...document.querySelectorAll(".badge.off")].length >= 1);
          // Появление уведомления об успехе: проверяем и его стиль.
          const row = page.locator("#admin-root tbody tr").first();
          await row.locator("button", { hasText: "Сохранить" }).click();
          await page.waitForSelector(".notice:not([hidden])");
          const a = await page.evaluate(pageAudit);
          const extra = [];
          if (!(await page.evaluate(() => document.querySelector(".badge.off") !== null))) extra.push("нет плашки отказа");
          report(`[agent ${tag}] админка (таблицы, плашки, уведомление)`, a, extra);
          await shot(page, `ui-agent-admin-${scheme}-${width}`);
          await ctx.close();
        }

        /* ---------- ENTINEQ (публичное) ---------- */
        {
          const { ctx, page } = await newPage();
          await page.goto(P_FRONT);
          await page.waitForSelector("#auth-view:not([hidden])");
          report(`[public ${tag}] вход`, await page.evaluate(pageAudit));
          await page.click("#tab-register");
          report(`[public ${tag}] регистрация`, await page.evaluate(pageAudit));
          check(`[public ${tag}] цвет фона соответствует теме`, (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === (scheme === "dark" ? "rgb(13, 14, 16)" : "rgb(245, 245, 243)"));
          await page.fill("#register-code", await inviteLimited());
          await page.fill("#register-email", `pub${++seq}@ui.test`);
          await page.fill("#register-password", "public-password-123");
          await page.click("#register-submit");
          await page.waitForSelector("#app-view:not([hidden])");
          await page.waitForFunction(() => document.getElementById("status").textContent === "готов");
          await page.fill("#input", "проверка оформления");
          await page.click("#send");
          await page.waitForSelector("#banner:not([hidden])");
          await sleep(350);
          let a = await page.evaluate(pageAudit);
          const extra = visibilityProblems("public", width, a);
          if (!(await page.evaluate(() => document.getElementById("usage-bar-fill").classList.contains("danger")))) extra.push("полоса лимита не красная при исчерпанном лимите");
          report(`[public ${tag}] чат, лимит исчерпан (баннер, красная полоса)`, a, extra);
          await shot(page, `ui-public-chat-${scheme}-${width}`);
          if (width <= 760) {
            await page.click("#sidebar-toggle");
            await sleep(350);
            a = await page.evaluate(pageAudit);
            report(`[public ${tag}] боковая панель открыта`, a, a.boxes.sidebar && a.boxes.sidebar.left >= -1 ? [] : ["панель не открылась по кнопке меню"]);
          }
          await ctx.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
})()
  .catch((error) => check("сценарий не упал с исключением", false, String(error && error.stack ? error.stack : error)))
  .finally(() => {
    stopAll();
    process.exit(summary() ? 0 : 1);
  });
