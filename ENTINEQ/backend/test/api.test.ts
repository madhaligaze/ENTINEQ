import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { isOriginAllowed } from "../src/guards.js";
import type { FastifyRequest } from "fastify";
import { call, createHarness, register, SECRET, SESSION_COOKIE, type Harness } from "./helpers.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => {
  h.core.mode = "ok";
  h.core.delayMs = 0;
  h.core.calls.length = 0;
});

const coreCalls = (path: string) => h.core.calls.filter((c) => c.path.startsWith(path));

describe("регистрация и вход", () => {
  it("register: проверяет ввод, шлёт ядру секрет, ставит безопасную cookie и не отдаёт токен странице", async () => {
    const result = await call(h, "POST", "/api/auth/register", { body: { email: "  New@Example.com ", password: "password-12345", inviteCode: " ENT-AAAA-BBBB-CCCC " } });
    expect(result.status).toBe(201);
    expect(result.json.user).toMatchObject({ email: "new@example.com", role: "public" });
    expect(result.json.usage.window.hours).toBe(5);
    expect(result.json).not.toHaveProperty("token");

    const cookie = result.cookies[SESSION_COOKIE]!;
    expect(cookie.value.length).toBeGreaterThan(20);
    expect(cookie.attrs).toContain("httponly");
    expect(cookie.attrs).toContain("samesite=lax");
    expect(cookie.attrs).toContain("path=/");
    expect(cookie.attrs).toMatch(/expires=/);
    expect(result.text).not.toContain(cookie.value);
    expect(result.text).not.toContain(SECRET);

    const forwarded = coreCalls("/internal/auth/register")[0]!;
    expect(forwarded.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(forwarded.body).toEqual({ email: "new@example.com", password: "password-12345", inviteCode: "ENT-AAAA-BBBB-CCCC" });
  });

  it("cookie получает Secure, когда включён production-режим", async () => {
    h.cfg.cookieSecure = true;
    try {
      const result = await call(h, "POST", "/api/auth/login", { body: { email: "a@example.com", password: "password-12345" } });
      expect(result.cookies[SESSION_COOKIE]!.attrs).toContain("secure");
    } finally {
      h.cfg.cookieSecure = false;
    }
  });

  it("плохой ввод отклоняется без обращения к ядру, сообщения по-русски", async () => {
    const cases: [unknown, RegExp][] = [
      [{ email: "не-почта", password: "password-12345", inviteCode: "ENT-AAAA-BBBB-CCCC" }, /.+/],
      [{ email: "a@example.com", password: "short", inviteCode: "ENT-AAAA-BBBB-CCCC" }, /минимум 10/],
      [{ email: "a@example.com", password: "password-12345", inviteCode: "x" }, /приглашения/],
      [{}, /.+/],
      [[], /.+/],
    ];
    for (const [body, message] of cases) {
      const result = await call(h, "POST", "/api/auth/register", { body });
      expect(result.status).toBe(400);
      expect(result.json.error.code).toBe("invalid_request");
      expect(result.json.error.message).toMatch(message);
    }
    expect(coreCalls("/internal/auth")).toHaveLength(0);
  });

  it("ошибки ядра доходят до пользователя как есть: код, статус и текст", async () => {
    const bad = await call(h, "POST", "/api/auth/register", { body: { email: "a@example.com", password: "password-12345", inviteCode: "ENT-BAD0-BAD0-BAD0" } });
    expect([bad.status, bad.json.error.code]).toEqual([400, "invalid_invite"]);
    const taken = await call(h, "POST", "/api/auth/register", { body: { email: "taken@example.com", password: "password-12345", inviteCode: "ENT-AAAA-BBBB-CCCC" } });
    expect([taken.status, taken.json.error.code]).toEqual([409, "email_taken"]);
    const wrong = await call(h, "POST", "/api/auth/login", { body: { email: "a@example.com", password: "wrong-password" } });
    expect([wrong.status, wrong.json.error.code, wrong.json.error.message]).toEqual([401, "invalid_credentials", "Неверный email или пароль."]);
    expect(wrong.cookies[SESSION_COOKIE]).toBeUndefined();
    const locked = await call(h, "POST", "/api/auth/login", { body: { email: "a@example.com", password: "locked-password" } });
    expect([locked.status, locked.json.error.code]).toEqual([423, "account_locked"]);
  });

  it("login: успешный вход ставит cookie и не раскрывает токен", async () => {
    const result = await call(h, "POST", "/api/auth/login", { body: { email: "A@Example.com", password: "password-12345" } });
    expect(result.status).toBe(200);
    expect(result.cookies[SESSION_COOKIE]).toBeDefined();
    expect(result.json).not.toHaveProperty("token");
    expect(coreCalls("/internal/auth/login")[0]!.body).toEqual({ email: "a@example.com", password: "password-12345" });
  });
});

describe("сессия", () => {
  it("/me без cookie — 401 без обращения к ядру", async () => {
    const result = await call(h, "GET", "/api/me");
    expect(result.status).toBe(401);
    expect(result.json.error.code).toBe("unauthorized");
    expect(h.core.calls).toHaveLength(0);
  });

  it("/me с cookie передаёт ядру токен отдельным заголовком", async () => {
    const user = await register(h);
    h.core.calls.length = 0;
    const result = await call(h, "GET", "/api/me", { cookie: user.cookie });
    expect(result.status).toBe(200);
    expect(result.json.user.email).toBe(user.email);
    const forwarded = coreCalls("/internal/me")[0]!;
    expect(forwarded.headers["x-user-token"]).toBe(user.cookie);
    expect(forwarded.headers.authorization).toBe(`Bearer ${SECRET}`);
  });

  it("если ядро не узнаёт токен — 401 и cookie стирается", async () => {
    const result = await call(h, "GET", "/api/me", { cookie: "stale-token-0123456789-abcdef" });
    expect(result.status).toBe(401);
    expect(result.cookies[SESSION_COOKIE]!.attrs).toMatch(/expires=thu, 01 jan 1970|max-age=0/);
  });

  it("выход: сессия закрывается в ядре, cookie стирается; сбой ядра выходу не мешает", async () => {
    const user = await register(h);
    const out = await call(h, "POST", "/api/auth/logout", { cookie: user.cookie, body: {} });
    expect(out.status).toBe(204);
    expect(out.cookies[SESSION_COOKIE]!.attrs).toMatch(/expires=thu, 01 jan 1970|max-age=0/);
    expect((await call(h, "GET", "/api/me", { cookie: user.cookie })).status).toBe(401);

    const another = await register(h);
    h.core.mode = "logout-fails";
    const failing = await call(h, "POST", "/api/auth/logout", { cookie: another.cookie, body: {} });
    expect(failing.status).toBe(204);
    expect(failing.cookies[SESSION_COOKIE]!.attrs).toMatch(/expires=thu, 01 jan 1970|max-age=0/);
    expect((await call(h, "POST", "/api/auth/logout", { body: {} })).status).toBe(204); // без cookie тоже спокойно
  });

  it("диалоги: список и сообщения пересылаются, идентификатор проверяется до обращения к ядру", async () => {
    const user = await register(h);
    h.core.calls.length = 0;
    const list = await call(h, "GET", "/api/conversations", { cookie: user.cookie });
    expect(list.json.conversations).toHaveLength(1);
    const id = list.json.conversations[0].id;
    const messages = await call(h, "GET", `/api/conversations/${id}/messages`, { cookie: user.cookie });
    expect(messages.json.messages[0]).toMatchObject({ role: "user", content: "привет" });
    h.core.calls.length = 0;
    const bad = await call(h, "GET", "/api/conversations/не-uuid/messages", { cookie: user.cookie });
    expect(bad.status).toBe(400);
    expect(h.core.calls).toHaveLength(0);
    const missing = await call(h, "GET", "/api/conversations/00000000-0000-4000-8000-000000000000/messages", { cookie: user.cookie });
    expect([missing.status, missing.json.error.code]).toEqual([404, "not_found"]);
  });
});

describe("сбои ядра не ломают приложение и не путаются с выходом пользователя", () => {
  it("ядро недоступно → 502 с понятным текстом, без деталей", async () => {
    const own = await createHarness();
    await own.core.close();
    try {
      const result = await call(own, "POST", "/api/auth/login", { body: { email: "a@example.com", password: "password-12345" } });
      expect(result.status).toBe(502);
      expect(result.json.error.code).toBe("upstream_unavailable");
      expect(result.text).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|fetch failed/);
      expect((await call(own, "GET", "/healthz")).json).toEqual({ ok: true }); // само приложение живо
    } finally {
      await own.app.close();
    }
  });

  it("ядро отвечает слишком долго → 502 по таймауту", async () => {
    const own = await createHarness({ AGENT_TIMEOUT_MS: "1000" });
    own.core.delayMs = 1600;
    try {
      const result = await call(own, "POST", "/api/auth/login", { body: { email: "a@example.com", password: "password-12345" } });
      expect(result.status).toBe(502);
      expect(result.json.error.code).toBe("upstream_unavailable");
    } finally {
      await own.close();
    }
  });

  it("ядро отклонило секрет → 502 «ошибка настройки», а не 401 «войдите»", async () => {
    const user = await register(h);
    h.core.mode = "secret-reject";
    const result = await call(h, "GET", "/api/me", { cookie: user.cookie });
    expect(result.status).toBe(502);
    expect(result.json.error.code).toBe("upstream_misconfigured");
    // Cookie пользователя при этом не трогаем: он ни в чём не виноват.
    expect(result.cookies[SESSION_COOKIE]).toBeUndefined();
  });

  it("5xx от ядра → 502; ответ не по контракту → 502 «несовместимые версии»", async () => {
    const user = await register(h);
    h.core.mode = "http500";
    expect((await call(h, "GET", "/api/me", { cookie: user.cookie })).json.error.code).toBe("upstream_unavailable");
    h.core.mode = "bad-contract";
    const bad = await call(h, "GET", "/api/me", { cookie: user.cookie });
    expect([bad.status, bad.json.error.code]).toEqual([502, "upstream_invalid"]);
    const badRegister = await call(h, "POST", "/api/auth/register", { body: { email: "z@example.com", password: "password-12345", inviteCode: "ENT-AAAA-BBBB-CCCC" } });
    expect(badRegister.json.error.code).toBe("upstream_invalid");
    expect(badRegister.cookies[SESSION_COOKIE]).toBeUndefined();
  });
});

describe("проверка связки /readyz", () => {
  it("готово, когда ядро видно, секрет принят и версия контракта совпадает", async () => {
    expect((await call(h, "GET", "/readyz")).json).toEqual({ ok: true });
  });

  it("называет причину: секрет, версия контракта, недоступность", async () => {
    h.core.mode = "secret-reject";
    expect((await call(h, "GET", "/readyz")).json).toMatchObject({ ok: false, reason: "upstream_misconfigured" });
    h.core.mode = "wrong-version";
    const mismatch = await call(h, "GET", "/readyz");
    expect(mismatch.status).toBe(503);
    expect(mismatch.json).toMatchObject({ ok: false, reason: "contract_mismatch", expected: 1, actual: 99 });
    h.core.mode = "old-core"; // ядро старше приложения: маршрута /ping ещё нет
    const old = await call(h, "GET", "/readyz");
    expect([old.status, old.json.reason]).toEqual([503, "contract_mismatch"]);
    const own = await createHarness();
    await own.core.close();
    try {
      expect((await call(own, "GET", "/readyz")).json).toMatchObject({ ok: false, reason: "upstream_unavailable" });
    } finally {
      await own.app.close();
    }
  });
});

describe("защита запросов", () => {
  it("чужой Origin отклоняется, только JSON принимается", async () => {
    const evil = await call(h, "POST", "/api/auth/login", { body: { email: "a@example.com", password: "password-12345" }, headers: { origin: "https://evil.example" } });
    expect(evil.status).toBe(403);
    const own = await call(h, "POST", "/api/auth/login", { body: { email: "a@example.com", password: "password-12345" }, headers: { origin: h.baseUrl } });
    expect(own.status).toBe(200);
    const crossSite = await call(h, "POST", "/api/auth/login", { body: { email: "a@example.com", password: "password-12345" }, headers: { "sec-fetch-site": "cross-site" } });
    expect(crossSite.status).toBe(403);
    const plain = await call(h, "POST", "/api/auth/login", { headers: { "content-type": "text/plain" } });
    expect(plain.status).toBe(415);
    const huge = await call(h, "POST", "/api/auth/login", { body: { email: "a@example.com", password: "x".repeat(200_000) } });
    expect(huge.status).toBe(413);
  });

  it("isOriginAllowed: список адресов, Host и браузерные метки", () => {
    const req = (headers: Record<string, string>) => ({ headers }) as unknown as FastifyRequest;
    expect(isOriginAllowed(req({ origin: "https://a.example", host: "a.example" }), [])).toBe(true);
    expect(isOriginAllowed(req({ origin: "https://b.example", host: "a.example" }), [])).toBe(false);
    expect(isOriginAllowed(req({ origin: "null", host: "a.example" }), [])).toBe(false);
    expect(isOriginAllowed(req({ origin: "https://front.example", host: "x" }), ["https://front.example"])).toBe(true);
    expect(isOriginAllowed(req({}), [])).toBe(true);
    expect(isOriginAllowed(req({ "sec-fetch-site": "same-site" }), [])).toBe(false);
  });

  it("попытки входа и регистрации ограничены по частоте", async () => {
    const own = await createHarness({ RATE_LIMIT_AUTH_PER_MIN: "10" });
    try {
      for (let i = 0; i < 10; i++) {
        expect((await call(own, "POST", "/api/auth/login", { body: { email: "a@example.com", password: "wrong-password" } })).status).toBe(401);
      }
      const blocked = await call(own, "POST", "/api/auth/login", { body: { email: "a@example.com", password: "wrong-password" } });
      expect([blocked.status, blocked.json.error.code]).toEqual([429, "rate_limited"]);
      const register = await call(own, "POST", "/api/auth/register", { body: { email: "a@example.com", password: "password-12345", inviteCode: "ENT-AAAA-BBBB-CCCC" } });
      expect(register.status).toBe(201); // у регистрации свой счётчик попыток
    } finally {
      await own.close();
    }
  });
});

describe("чистый API и заголовки", () => {
  it("корень — служебный JSON, страниц нет; заголовки безопасности на месте", async () => {
    const root = await call(h, "GET", "/");
    expect(root.status).toBe(200);
    expect(root.json).toEqual({ service: "entineq-backend", ok: true });
    const csp = root.response.headers.get("content-security-policy")!;
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(root.response.headers.get("x-content-type-options")).toBe("nosniff");
    for (const page of ["/index.html", "/js/main.js", "/styles.css"]) expect((await call(h, "GET", page)).status).toBe(404);
  });

  it("неизвестные адреса — одинаковый JSON, в ответах нет внутренностей; внутреннее API ядра наружу не проброшено", async () => {
    for (const url of ["/api/нет", "/нет-такой", "/.env", "/internal/me"]) {
      const result = await call(h, "GET", url);
      expect(result.status).toBe(404);
      expect(result.json.error.code).toBe("not_found");
      expect(result.text).not.toContain(SECRET);
    }
  });

  it("за фронтендом: Origin сверяется со списком ALLOWED_ORIGINS, а Host (адрес бэкенда) не важен", async () => {
    const own = await createHarness({ ALLOWED_ORIGINS: "https://frontend.example.com" });
    try {
      const login = (headers: Record<string, string>) =>
        call(own, "POST", "/api/auth/login", { body: { email: "a@example.com", password: "password-12345" }, headers: { host: "backend.internal:8080", ...headers } });
      expect((await login({ origin: "https://frontend.example.com" })).status).toBe(200);
      expect((await login({ origin: "https://evil.example.com" })).status).toBe(403);
      expect((await login({ origin: "http://backend.internal:8080" })).status).toBe(403);
    } finally {
      await own.close();
    }
  });
});
