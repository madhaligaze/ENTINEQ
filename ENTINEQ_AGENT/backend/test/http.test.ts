import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isOriginAllowed, SESSION_COOKIE } from "../src/routes/guards.js";
import { asCookie, createHarness, directSocket, internalHeaders, loginDirect, makePublic, makeTrusted, OWNER, ownerCookie, SECRET, uniqueEmail, type Harness } from "./helpers.js";
import type { FastifyRequest } from "fastify";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

const post = (url: string, payload: unknown, headers: Record<string, string> = {}) => h.app.inject({ method: "POST", url, payload: payload as object, headers });
const get = (url: string, headers: Record<string, string> = {}) => h.app.inject({ method: "GET", url, headers });

describe("служебные маршруты и заголовки", () => {
  it("healthz и readyz отвечают", async () => {
    expect((await get("/healthz")).json()).toEqual({ ok: true });
    expect((await get("/readyz")).json()).toEqual({ ok: true });
  });

  it("это чистый API: корень - служебный JSON, страниц нет; заголовки безопасности на месте", async () => {
    const response = await get("/");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ service: "entineq-agent-backend", ok: true });
    const csp = String(response.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    for (const page of ["/index.html", "/js/main.js", "/styles.css"]) expect((await get(page)).statusCode).toBe(404);
  });

  it("неизвестные адреса - одинаковый JSON", async () => {
    for (const url of ["/api/нет-такого", "/нет-такой-страницы", "/.env", "/internal/нет-такого"]) {
      const response = await get(url, internalHeaders());
      expect(response.statusCode).toBe(404);
      expect(response.json().error.code).toBe("not_found");
    }
  });

  it("за фронтендом: Origin сверяется со списком ALLOWED_ORIGINS, а Host (адрес бэкенда) не важен", async () => {
    const own = await createHarness({ ALLOWED_ORIGINS: "https://agent-frontend.example.com" });
    try {
      const login = (headers: Record<string, string>) =>
        own.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: OWNER.email, password: OWNER.password }, headers: { host: "agent-backend.internal:8080", ...headers } });
      expect((await login({ origin: "https://agent-frontend.example.com" })).statusCode).toBe(200);
      const wrong = await login({ origin: "https://evil.example.com" });
      expect([wrong.statusCode, wrong.json().error.code]).toEqual([403, "forbidden"]);
      // Адрес самого бэкенда в списке не значится - запрос с него не пройдёт.
      expect((await login({ origin: "http://agent-backend.internal:8080" })).statusCode).toBe(403);
    } finally {
      await own.close();
    }
  });
});

describe("вход в собственный интерфейс", () => {
  it("успешный вход ставит безопасную cookie и возвращает пользователя и лимиты", async () => {
    const response = await post("/api/auth/login", { email: OWNER.email.toUpperCase(), password: OWNER.password });
    expect(response.statusCode).toBe(200);
    const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE)!;
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
    expect(cookie.expires!.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    const body = response.json();
    expect(body.user).toMatchObject({ email: OWNER.email, role: "owner" });
    expect(body.usage.window.hours).toBe(5);
    expect(JSON.stringify(body)).not.toContain("passwordHash");
  });

  it("cookie получает флаг Secure, когда включён production-режим", async () => {
    h.cfg.cookieSecure = true;
    try {
      const response = await post("/api/auth/login", { email: OWNER.email, password: OWNER.password });
      expect(response.cookies.find((c) => c.name === SESSION_COOKIE)?.secure).toBe(true);
    } finally {
      h.cfg.cookieSecure = false;
    }
  });

  it("неверные данные: одинаковый 401 для неверного пароля и неизвестного email", async () => {
    const wrong = await post("/api/auth/login", { email: OWNER.email, password: "неверный-пароль" });
    const unknown = await post("/api/auth/login", { email: uniqueEmail(), password: "неверный-пароль" });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    expect(wrong.cookies).toHaveLength(0);
  });

  it("публичный аккаунт через прямую дверь не входит", async () => {
    const pub = await makePublic(h);
    const response = await post("/api/auth/login", { email: pub.email, password: pub.password });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe("invalid_credentials");
  });

  it("плохой ввод даёт 400 с русским сообщением, а не 500", async () => {
    const badEmail = await post("/api/auth/login", { email: "не-почта", password: "x" });
    expect(badEmail.statusCode).toBe(400);
    expect(badEmail.json().error.code).toBe("invalid_request");
    expect(badEmail.json().error.message).not.toMatch(/[A-Za-z]{6,} [a-z]+ [a-z]+/); // не английская фраза Zod
    expect((await post("/api/auth/login", {})).statusCode).toBe(400);
    expect((await post("/api/auth/login", [])).statusCode).toBe(400);
    const brokenJson = await h.app.inject({ method: "POST", url: "/api/auth/login", payload: "{не json", headers: { "content-type": "application/json" } });
    expect(brokenJson.statusCode).toBe(400);
    const wrongType = await h.app.inject({ method: "POST", url: "/api/auth/login", payload: "a=b", headers: { "content-type": "text/plain" } });
    expect(wrongType.statusCode).toBe(415);
    expect(wrongType.json().error.message).toBe("Ожидается JSON.");
  });

  it("слишком большое тело отклоняется", async () => {
    const response = await post("/api/auth/login", { email: OWNER.email, password: "x".repeat(200_000) });
    expect(response.statusCode).toBe(413);
  });

  it("выход закрывает сессию", async () => {
    const token = await ownerCookie(h);
    expect((await get("/api/me", asCookie(token))).statusCode).toBe(200);
    const out = await post("/api/auth/logout", {}, asCookie(token));
    expect(out.statusCode).toBe(204);
    expect(out.headers["set-cookie"]).toContain(`${SESSION_COOKIE}=;`);
    expect((await get("/api/me", asCookie(token))).statusCode).toBe(401);
  });

  it("/api/me требует вход", async () => {
    expect((await get("/api/me")).statusCode).toBe(401);
    expect((await get("/api/me", asCookie("forged-token"))).statusCode).toBe(401);
    const response = await get("/api/me", asCookie(await ownerCookie(h)));
    expect(response.json().user.role).toBe("owner");
  });
});

describe("защита от запросов с чужих сайтов (CSRF)", () => {
  it("запрос, меняющий состояние, с чужим Origin отклоняется, со своим - проходит", async () => {
    const token = await ownerCookie(h);
    const evil = await post("/api/auth/logout", {}, { ...asCookie(token), origin: "https://evil.example", host: "agent.example" });
    expect(evil.statusCode).toBe(403);
    expect((await get("/api/me", asCookie(token))).statusCode).toBe(200); // сессия не пострадала
    const own = await post("/api/auth/logout", {}, { ...asCookie(token), origin: "https://agent.example", host: "agent.example" });
    expect(own.statusCode).toBe(204);
  });

  it("браузерная метка cross-site без Origin тоже отклоняется", async () => {
    const response = await post("/api/auth/login", { email: OWNER.email, password: OWNER.password }, { "sec-fetch-site": "cross-site" });
    expect(response.statusCode).toBe(403);
    const ok = await post("/api/auth/login", { email: OWNER.email, password: OWNER.password }, { "sec-fetch-site": "same-origin" });
    expect(ok.statusCode).toBe(200);
  });

  it("isOriginAllowed: явный список адресов и сравнение с Host", () => {
    const req = (headers: Record<string, string>) => ({ headers }) as unknown as FastifyRequest;
    expect(isOriginAllowed(req({ origin: "https://a.example", host: "a.example" }), [])).toBe(true);
    expect(isOriginAllowed(req({ origin: "https://b.example", host: "a.example" }), [])).toBe(false);
    expect(isOriginAllowed(req({ origin: "null", host: "a.example" }), [])).toBe(false);
    expect(isOriginAllowed(req({ origin: "мусор", host: "a.example" }), [])).toBe(false);
    expect(isOriginAllowed(req({ origin: "https://front.example", host: "api.internal" }), ["https://front.example"])).toBe(true);
    expect(isOriginAllowed(req({ origin: "https://a.example", host: "a.example" }), ["https://front.example"])).toBe(false);
    expect(isOriginAllowed(req({}), [])).toBe(true);
    expect(isOriginAllowed(req({ "sec-fetch-site": "same-site" }), [])).toBe(false);
  });
});

describe("администрирование", () => {
  it("доступно только владельцу", async () => {
    const trusted = await makeTrusted(h);
    for (const [method, url] of [["GET", "/api/admin/users"], ["GET", "/api/admin/invites"], ["GET", "/api/admin/usage"]] as const) {
      expect((await h.app.inject({ method, url })).statusCode).toBe(401);
      expect((await h.app.inject({ method, url, headers: asCookie(trusted.cookie) })).statusCode).toBe(403);
    }
    expect((await post("/api/admin/users", { email: uniqueEmail(), password: "password-12345", role: "trusted" }, asCookie(trusted.cookie))).statusCode).toBe(403);
  });

  it("создание пользователей: лимиты по умолчанию, явный null, дубликаты и слабые пароли", async () => {
    const owner = asCookie(await ownerCookie(h));
    const withDefaults = await post("/api/admin/users", { email: uniqueEmail(), password: "password-12345", role: "public" }, owner);
    expect(withDefaults.statusCode).toBe(201);
    const list = (await get("/api/admin/users", owner)).json().users as { id: string; monthlyBudgetUsd: number | null; windowLimitUsd: number | null }[];
    const created = list.find((u) => u.id === withDefaults.json().user.id)!;
    expect(created).toMatchObject({ monthlyBudgetUsd: 10, windowLimitUsd: 1 });

    const unlimited = await post("/api/admin/users", { email: uniqueEmail(), password: "password-12345", role: "trusted", monthlyBudgetUsd: null, windowLimitUsd: null }, owner);
    const row = ((await get("/api/admin/users", owner)).json().users as typeof list).find((u) => u.id === unlimited.json().user.id)!;
    expect(row).toMatchObject({ monthlyBudgetUsd: null, windowLimitUsd: null });

    const dup = uniqueEmail();
    await post("/api/admin/users", { email: dup, password: "password-12345", role: "trusted" }, owner);
    expect((await post("/api/admin/users", { email: dup, password: "password-12345", role: "trusted" }, owner)).json().error.code).toBe("email_taken");
    expect((await post("/api/admin/users", { email: uniqueEmail(), password: "короткий", role: "trusted" }, owner)).statusCode).toBe(400);
    expect((await post("/api/admin/users", { email: uniqueEmail(), password: "password-12345", role: "owner" }, owner)).statusCode).toBe(400);
    expect((await post("/api/admin/users", { email: uniqueEmail(), password: "password-12345", role: "trusted", monthlyBudgetUsd: -5 }, owner)).statusCode).toBe(400);
  });

  it("изменение лимитов, отключение и сброс пароля вступают в силу сразу", async () => {
    const owner = asCookie(await ownerCookie(h));
    const user = await makeTrusted(h);

    const patched = await h.app.inject({ method: "PATCH", url: `/api/admin/users/${user.id}`, headers: owner, payload: { monthlyBudgetUsd: 3, windowLimitUsd: null } });
    expect(patched.json().user).toMatchObject({ monthlyBudgetUsd: 3, windowLimitUsd: null });

    const reset = await h.app.inject({ method: "PATCH", url: `/api/admin/users/${user.id}`, headers: owner, payload: { password: "fresh-password-123" } });
    expect(reset.statusCode).toBe(200);
    expect((await get("/api/me", asCookie(user.cookie))).statusCode).toBe(401); // старый вход закрыт
    const relogin = await loginDirect(h, user.email, "fresh-password-123");
    expect((await get("/api/me", asCookie(relogin))).statusCode).toBe(200);

    const disabled = await h.app.inject({ method: "PATCH", url: `/api/admin/users/${user.id}`, headers: owner, payload: { isActive: false } });
    expect(disabled.json().user.isActive).toBe(false);
    expect((await get("/api/me", asCookie(relogin))).statusCode).toBe(401);
    expect((await post("/api/auth/login", { email: user.email, password: "fresh-password-123" })).json().error.code).toBe("account_disabled");
  });

  it("владельца отключить нельзя; неизвестный id и пустое изменение - ошибки", async () => {
    const owner = asCookie(await ownerCookie(h));
    const users = (await get("/api/admin/users", owner)).json().users as { id: string; role: string }[];
    const ownerId = users.find((u) => u.role === "owner")!.id;
    const attempt = await h.app.inject({ method: "PATCH", url: `/api/admin/users/${ownerId}`, headers: owner, payload: { isActive: false } });
    expect(attempt.statusCode).toBe(400);
    expect((await h.app.inject({ method: "PATCH", url: "/api/admin/users/00000000-0000-4000-8000-000000000000", headers: owner, payload: { isActive: true } })).statusCode).toBe(404);
    expect((await h.app.inject({ method: "PATCH", url: `/api/admin/users/${ownerId}`, headers: owner, payload: {} })).statusCode).toBe(400);
    expect((await h.app.inject({ method: "PATCH", url: "/api/admin/users/не-uuid", headers: owner, payload: { isActive: true } })).statusCode).toBe(400);
  });

  it("приглашения: коды видны один раз, отзыв, список", async () => {
    const owner = asCookie(await ownerCookie(h));
    const created = await post("/api/admin/invites", { count: 3, expiresInDays: 7, monthlyBudgetUsd: 4, windowLimitUsd: 0.5 }, owner);
    expect(created.statusCode).toBe(201);
    const invites = created.json().invites as { id: string; code: string }[];
    expect(invites).toHaveLength(3);
    expect(invites[0]!.code).toMatch(/^ENT-/);

    const listed = (await get("/api/admin/invites", owner)).json().invites as { id: string; status: string; codeHint: string; code?: string }[];
    const mine = listed.filter((i) => invites.some((c) => c.id === i.id));
    expect(mine).toHaveLength(3);
    expect(mine.every((i) => i.status === "active" && i.code === undefined)).toBe(true);
    expect(mine[0]!.codeHint).toHaveLength(4);

    expect((await h.app.inject({ method: "DELETE", url: `/api/admin/invites/${invites[0]!.id}`, headers: owner })).statusCode).toBe(204);
    expect((await h.app.inject({ method: "DELETE", url: `/api/admin/invites/${invites[0]!.id}`, headers: owner })).statusCode).toBe(404);
    expect((await post("/api/admin/invites", { count: 0 }, owner)).statusCode).toBe(400);
    expect((await post("/api/admin/invites", { count: 51 }, owner)).statusCode).toBe(400);
    expect((await post("/api/admin/invites", undefined, owner)).statusCode).toBe(201); // всё по умолчанию
  });

  it("отчёт по расходам: месяц проверяется, по умолчанию текущий", async () => {
    const owner = asCookie(await ownerCookie(h));
    const report = (await get("/api/admin/usage", owner)).json();
    expect(report.month).toMatch(/^\d{4}-\d{2}$/);
    expect(Array.isArray(report.users)).toBe(true);
    expect(typeof report.totalUsd).toBe("number");
    expect((await get("/api/admin/usage?month=2020-01", owner)).json().month).toBe("2020-01");
    expect((await get("/api/admin/usage?month=2020-13", owner)).statusCode).toBe(400);
    expect((await get("/api/admin/usage?month=все", owner)).statusCode).toBe(400);
  });
});

describe("внутренняя дверь для публичного приложения", () => {
  it("без секрета и с неверным секретом - отказ, одинаковый для всех маршрутов", async () => {
    for (const [method, url] of [["GET", "/internal/me"], ["POST", "/internal/auth/login"], ["POST", "/internal/auth/register"], ["GET", "/internal/conversations"]] as const) {
      const none = await h.app.inject({ method, url, payload: method === "POST" ? {} : undefined });
      const wrong = await h.app.inject({ method, url, headers: { authorization: "Bearer wrong" }, payload: method === "POST" ? {} : undefined });
      const basic = await h.app.inject({ method, url, headers: { authorization: `Basic ${SECRET}` }, payload: method === "POST" ? {} : undefined });
      for (const response of [none, wrong, basic]) {
        expect(response.statusCode).toBe(401);
        expect(response.json().error.code).toBe("internal_unauthorized");
      }
    }
  });

  it("ping: проверка связки требует секрет и сообщает версию контракта", async () => {
    expect((await get("/internal/ping")).statusCode).toBe(401);
    const ok = await get("/internal/ping", internalHeaders());
    expect(ok.json()).toEqual({ ok: true, service: "entineq-agent", contract: 1 });
  });

  it("секрет в строке запроса не принимается", async () => {
    expect((await get(`/internal/me?key=${SECRET}`)).statusCode).toBe(401);
  });

  it("с секретом, но без токена пользователя - 401", async () => {
    expect((await get("/internal/me", internalHeaders())).statusCode).toBe(401);
    expect((await get("/internal/me", internalHeaders("forged-token"))).statusCode).toBe(401);
  });

  it("регистрация, вход, профиль и выход публичного пользователя", async () => {
    const pub = await makePublic(h, { monthly: 6, window: 0.6 });
    const me = await get("/internal/me", internalHeaders(pub.token));
    expect(me.statusCode).toBe(200);
    expect(me.json().user).toMatchObject({ email: pub.email, role: "public" });
    expect(me.json().usage).toMatchObject({ monthBudgetUsd: 6, window: { limitUsd: 0.6, active: false, spentUsd: 0 } });

    const login = await post("/internal/auth/login", { email: pub.email, password: pub.password }, internalHeaders());
    expect(login.statusCode).toBe(200);
    expect(login.json().token).not.toBe(pub.token);

    const out = await post("/internal/auth/logout", {}, internalHeaders(login.json().token));
    expect(out.statusCode).toBe(204);
    expect((await get("/internal/me", internalHeaders(login.json().token))).statusCode).toBe(401);
    expect((await get("/internal/me", internalHeaders(pub.token))).statusCode).toBe(200); // другой вход жив
  });

  it("владелец и доверенный через внутреннюю дверь не входят", async () => {
    const trusted = await makeTrusted(h);
    for (const [email, password] of [[OWNER.email, OWNER.password], [trusted.email, trusted.password]]) {
      const response = await post("/internal/auth/login", { email, password }, internalHeaders());
      expect(response.statusCode).toBe(401);
      expect(response.json().error.code).toBe("invalid_credentials");
    }
  });

  it("токены «дверей» не взаимозаменяемы", async () => {
    const pub = await makePublic(h);
    const owner = await ownerCookie(h);
    expect((await get("/api/me", asCookie(pub.token))).statusCode).toBe(401);
    expect((await get("/internal/me", internalHeaders(owner))).statusCode).toBe(401);
  });

  it("регистрация: неверный код, слабый пароль, повторное использование", async () => {
    const bad = await post("/internal/auth/register", { email: uniqueEmail(), password: "password-12345", inviteCode: "ENT-ZZZZ-ZZZZ-ZZZZ" }, internalHeaders());
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("invalid_invite");
    const weak = await post("/internal/auth/register", { email: uniqueEmail(), password: "123", inviteCode: "ENT-ZZZZ-ZZZZ-ZZZZ" }, internalHeaders());
    expect(weak.statusCode).toBe(400);
    expect(weak.json().error.code).toBe("invalid_request");
    const pub = await makePublic(h);
    const reuse = await post("/internal/auth/register", { email: uniqueEmail(), password: "password-12345", inviteCode: pub.code }, internalHeaders());
    expect(reuse.json().error.code).toBe("invalid_invite");
  });

  it("пользователь видит только свои диалоги", async () => {
    const a = await makePublic(h);
    const b = await makePublic(h);
    const { id } = await createConversationVia(a.token, "секрет пользователя A");
    const listB = (await get("/internal/conversations", internalHeaders(b.token))).json().conversations as unknown[];
    expect(listB).toEqual([]);
    expect((await get(`/internal/conversations/${id}/messages`, internalHeaders(b.token))).statusCode).toBe(404);
    const own = await get(`/internal/conversations/${id}/messages`, internalHeaders(a.token));
    expect(own.json().messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
    expect((await get("/internal/conversations/не-uuid/messages", internalHeaders(a.token))).statusCode).toBe(400);
  });
});

describe("ограничение частоты входов", () => {
  it("после 10 попыток в минуту - 429, и это не ломает общий формат ошибок", async () => {
    const own = await createHarness({ RATE_LIMIT_LOGIN_PER_MIN: "10", RATE_LIMIT_WS_PER_MIN: "3" });
    try {
      const attempt = () => own.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "nobody@example.com", password: "неверный-пароль" } });
      for (let i = 0; i < 10; i++) expect((await attempt()).statusCode).toBe(401);
      const blocked = await attempt();
      expect(blocked.statusCode).toBe(429);
      expect(blocked.json().error.code).toBe("rate_limited");
    } finally {
      await own.close();
    }
  });

  it("открытия WebSocket с одного адреса тоже ограничены", async () => {
    const own = await createHarness({ RATE_LIMIT_WS_PER_MIN: "3" });
    try {
      const cookie = await ownerCookie(own);
      for (let i = 0; i < 3; i++) (await directSocket(own, cookie)).close();
      await expect(directSocket(own, cookie)).rejects.toThrow("HTTP 429");
    } finally {
      await own.close();
    }
  });
});

// Создаёт диалог через настоящий WebSocket внутренней двери (так же, как это делает публичное приложение).
async function createConversationVia(token: string, text: string): Promise<{ id: string }> {
  const { internalSocket } = await import("./helpers.js");
  const socket = await internalSocket(h, token);
  const events = await socket.turn({ text });
  socket.close();
  const conversation = events.find((e) => e.kind === "conversation") as { id: string } | undefined;
  if (!conversation) throw new Error(`нет диалога: ${JSON.stringify(events)}`);
  return { id: conversation.id };
}
