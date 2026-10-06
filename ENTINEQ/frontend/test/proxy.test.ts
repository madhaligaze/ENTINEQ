import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { call, createHarness, rawRequest, type Harness } from "./helpers.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => {
  h.backend.mode = "ok";
  h.backend.delayMs = 0;
  h.backend.calls.length = 0;
});

describe("страницы", () => {
  it("главная и ресурсы отдаются, без кэша, со строгой политикой безопасности", async () => {
    const page = await call(h, "GET", "/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.text).toContain("<title>");
    expect(page.headers.get("cache-control")).toBe("no-cache");
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(page.headers.get("x-content-type-options")).toBe("nosniff");

    const script = await call(h, "GET", "/js/main.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toMatch(/javascript/);
    expect((await call(h, "GET", "/styles.css")).headers.get("content-type")).toContain("text/css");
    expect(h.backend.calls).toHaveLength(0); // страницы бэкенд не трогают
  });

  it("неизвестные адреса - 404 текстом; выйти за пределы папки со страницами нельзя", async () => {
    expect((await call(h, "GET", "/нет-такой")).status).toBe(404);
    for (const path of ["/../package.json", "/..%2fpackage.json", "/js/../../package.json", "/%2e%2e/package.json", "/js/%2e%2e/%2e%2e/package.json"]) {
      const result = await call(h, "GET", path);
      expect(result.text).not.toContain('"name"');
      expect(result.status).not.toBe(200);
    }
  });

  it("адреса, не относящиеся к интерфейсу, на бэкенд не пересылаются", async () => {
    for (const path of ["/internal/me", "/internal/ping", "/admin", "/api", "/readyz-backend", "/.env"]) {
      const result = await call(h, "GET", path);
      expect(result.status).toBe(404);
    }
    expect(h.backend.calls).toHaveLength(0);
  });
});

describe("пересылка /api на бэкенд", () => {
  it("GET: путь, строка запроса, cookie и Origin доходят; ответ не кэшируется", async () => {
    const result = await call(h, "GET", "/api/me?month=2026-10", { headers: { cookie: "entineq_session=tok", origin: "https://front.example", "user-agent": "test-agent" } });
    expect(result.status).toBe(200);
    expect(result.headers.get("cache-control")).toBe("no-store");
    const seen = result.json.headers;
    expect(result.json.url).toBe("/api/me?month=2026-10");
    expect(seen.cookie).toBe("entineq_session=tok");
    expect(seen.origin).toBe("https://front.example");
    expect(seen["user-agent"]).toBe("test-agent");
  });

  it("настоящий IP и адрес сайта передаются заголовками X-Forwarded-*; подделка от браузера отбрасывается", async () => {
    const result = await call(h, "GET", "/api/me", {
      headers: { "x-forwarded-for": "6.6.6.6", "x-forwarded-host": "evil.example", "x-forwarded-proto": "https", host: new URL(h.baseUrl).host },
    });
    const seen = result.json.headers;
    expect(seen["x-forwarded-for"]).toBe("127.0.0.1");
    expect(seen["x-forwarded-host"]).toBe(new URL(h.baseUrl).host);
    expect(seen["x-forwarded-proto"]).toBe("http");
  });

  it("чужие служебные заголовки (Authorization, X-User-Token и др.) до бэкенда не доходят", async () => {
    const result = await call(h, "GET", "/api/me", {
      headers: { authorization: "Bearer stolen", "x-user-token": "forged", "x-internal-secret": "x", "x-anything": "y", cookie: "a=b" },
    });
    const seen = result.json.headers;
    expect(seen.authorization).toBeUndefined();
    expect(seen["x-user-token"]).toBeUndefined();
    expect(seen["x-internal-secret"]).toBeUndefined();
    expect(seen["x-anything"]).toBeUndefined();
    expect(seen.cookie).toBe("a=b");
  });

  it("POST/PATCH/DELETE: тело JSON (в том числе кириллица) пересылается без искажений", async () => {
    const body = { email: "тест@example.com", text: "привет, мир 🌍", nested: { n: [1, 2, 3] } };
    const post = await call(h, "POST", "/api/echo", { body });
    expect(post.json.body).toEqual(body);
    expect(post.json.headers["content-type"]).toContain("application/json");
    const patch = await call(h, "PATCH", "/api/echo", { body: { isActive: false } });
    expect(patch.json).toMatchObject({ method: "PATCH", body: { isActive: false } });
    const del = await call(h, "DELETE", "/api/echo");
    expect(del.json).toMatchObject({ method: "DELETE", body: null });
  });

  it("POST без тела проходит (выход из аккаунта), 204 сохраняется", async () => {
    const result = await call(h, "POST", "/api/auth/logout");
    expect(result.status).toBe(204);
    expect(result.text).toBe("");
  });

  it("Set-Cookie доходит до браузера целиком: несколько cookie и все атрибуты", async () => {
    const result = await call(h, "POST", "/api/auth/login", { body: { email: "a@example.com", password: "password-12345" } });
    expect(result.setCookies).toHaveLength(2);
    expect(result.setCookies[0]).toBe("entineq_session=abc123; Path=/; HttpOnly; SameSite=Lax; Secure");
    expect(result.setCookies[1]).toBe("second=2; Path=/");
  });

  it("коды и тексты ошибок бэкенда проходят без изменений", async () => {
    for (const code of [400, 401, 403, 404, 409, 423, 429, 500]) {
      const result = await call(h, "GET", `/api/status/${code}`);
      expect(result.status).toBe(code);
      expect(result.json).toEqual({ error: { code: `status_${code}`, message: `Ответ ${code}` } });
    }
  });

  it("не JSON, битый JSON и слишком большое тело отклоняются у фронтенда и до бэкенда не доходят", async () => {
    const plain = await call(h, "POST", "/api/echo", { rawBody: "a=b", headers: { "content-type": "text/plain" } });
    expect([plain.status, plain.json.error.message]).toEqual([415, "Ожидается JSON."]);
    const broken = await call(h, "POST", "/api/echo", { rawBody: "{не json", headers: { "content-type": "application/json" } });
    expect(broken.status).toBe(400);
    const huge = await call(h, "POST", "/api/echo", { body: { x: "я".repeat(120_000) } });
    expect(huge.status).toBe(413);
    expect(h.backend.calls).toHaveLength(0);
  });
});

describe("выход за пределы /api через точки и кодированные символы в пути", () => {
  // Адрес браузера вида /api/.. сервер получает как есть, а разбор URL при пересылке «схлопывает» ../ и тем самым
  // мог бы вывести запрос на другие адреса бэкенда (/internal/*, /healthz). Такие пути отклоняются целиком.
  const attacks = [
    "/api/../healthz",
    "/api/../internal/ping",
    "/api/%2e%2e/healthz",
    "/api/%2E%2E/healthz",
    "/api/.%2e/healthz",
    "/api/..%2fhealthz",
    "/api/..%2Fhealthz",
    "/api/%2e%2e%2fhealthz",
    "/api/..%5chealthz",
    "/api/..\\healthz",
    "/api/auth/../../healthz",
    "/api/./me/../../healthz",
    "/api//healthz",
    "/api/me%00",
  ];

  it("ни один вариант не доходит до бэкенда", async () => {
    for (const path of attacks) {
      h.backend.calls.length = 0;
      const result = await rawRequest(h, "GET", path);
      expect([path, result.status >= 400 && result.status < 500]).toEqual([path, true]);
      expect([path, result.text.includes('"ok":true')]).toEqual([path, false]);
      expect([path, h.backend.calls.map((c) => c.url)]).toEqual([path, []]);
    }
  });

  it("то же для методов, меняющих данные (вход, регистрация, произвольный POST)", async () => {
    for (const method of ["POST", "PATCH", "DELETE"]) {
      for (const path of ["/api/../healthz", "/api/%2e%2e/api/auth/login", "/api/auth/../../internal/auth/login"]) {
        h.backend.calls.length = 0;
        const result = await rawRequest(h, method, path);
        expect([method, path, result.status >= 400 && result.status < 500]).toEqual([method, path, true]);
        expect([method, path, h.backend.calls.map((c) => c.url)]).toEqual([method, path, []]);
      }
    }
  });

  it("обычные пути с параметрами и строкой запроса по-прежнему проходят", async () => {
    const ok = [
      "/api/me",
      "/api/me?month=2026-10",
      "/api/conversations/00000000-0000-4000-8000-000000000000/messages",
      "/api/admin/users/00000000-0000-4000-8000-000000000000",
      "/api/status/404",
    ];
    for (const path of ok) {
      h.backend.calls.length = 0;
      const result = await rawRequest(h, "GET", path);
      expect([path, result.status === 502 || result.status === 0]).toEqual([path, false]);
      expect([path, h.backend.calls.length]).toEqual([path, 1]);
      expect(h.backend.calls[0]!.url).toBe(path);
    }
  });

  it("при этом сервис продолжает работать для обычных запросов", async () => {
    expect((await call(h, "GET", "/api/me")).status).toBe(200);
  });
});

describe("сбои бэкенда", () => {
  it("бэкенд недоступен: 502 с понятным текстом, внутренностей нет; сам сервис живой", async () => {
    const own = await createHarness();
    await own.backend.close();
    try {
      const result = await call(own, "GET", "/api/me");
      expect(result.status).toBe(502);
      expect(result.json).toEqual({ error: { code: "upstream_unavailable", message: "Сервис временно недоступен. Попробуйте чуть позже." } });
      expect(result.text).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|fetch failed|undici/i);
      expect(result.headers.get("cache-control")).toBe("no-store");
      expect((await call(own, "GET", "/healthz")).json).toEqual({ ok: true });
      expect((await call(own, "GET", "/")).status).toBe(200); // страница по-прежнему открывается
      const ready = await call(own, "GET", "/readyz");
      expect([ready.status, ready.json]).toEqual([503, { ok: false, reason: "backend_unreachable" }]);
    } finally {
      await own.app.close();
    }
  });

  it("бэкенд отвечает слишком долго: 502 по таймауту", async () => {
    const own = await createHarness({ BACKEND_TIMEOUT_MS: "1000" });
    try {
      const result = await call(own, "GET", "/api/slow");
      expect(result.status).toBe(502);
      expect(result.json.error.code).toBe("upstream_unavailable");
    } finally {
      await own.close();
    }
  });

  it("/readyz: бэкенд здоров - ok, нездоров - 503 с причиной", async () => {
    expect((await call(h, "GET", "/readyz")).json).toEqual({ ok: true });
    h.backend.mode = "unhealthy";
    const unhealthy = await call(h, "GET", "/readyz");
    expect([unhealthy.status, unhealthy.json]).toEqual([503, { ok: false, reason: "backend_unhealthy" }]);
  });
});

describe("ограничение частоты", () => {
  it("попытки входа и регистрации ограничены по IP; остальное API не затронуто", async () => {
    const own = await createHarness({ RATE_LIMIT_AUTH_PER_MIN: "5" });
    try {
      const body = { email: "a@example.com", password: "password-12345" };
      for (let i = 0; i < 5; i++) expect((await call(own, "POST", "/api/auth/login", { body })).status).toBe(200);
      const blocked = await call(own, "POST", "/api/auth/login", { body });
      expect([blocked.status, blocked.json.error.code]).toEqual([429, "rate_limited"]);
      expect((await call(own, "POST", "/api/auth/register", { body })).status).toBe(200); // свой счётчик
      expect((await call(own, "GET", "/api/me")).status).toBe(200);
      // Заблокированный запрос до бэкенда не дошёл.
      expect(own.backend.calls.filter((c) => c.url === "/api/auth/login")).toHaveLength(5);
    } finally {
      await own.close();
    }
  });

  it("лимит учитывает IP из X-Forwarded-For только когда прокси доверенный", async () => {
    const trusting = await createHarness({ RATE_LIMIT_AUTH_PER_MIN: "2", TRUST_PROXY_HOPS: "1" });
    try {
      const body = { email: "a@example.com", password: "password-12345" };
      const asClient = (ip: string) => call(trusting, "POST", "/api/auth/login", { body, headers: { "x-forwarded-for": ip } });
      // Два разных посетителя за доверенным прокси не мешают друг другу.
      for (let i = 0; i < 2; i++) expect((await asClient("203.0.113.1")).status).toBe(200);
      expect((await asClient("203.0.113.1")).status).toBe(429);
      expect((await asClient("203.0.113.2")).status).toBe(200);
      // Бэкенд получает настоящий адрес посетителя.
      expect(String(trusting.backend.calls.at(-1)!.headers["x-forwarded-for"])).toBe("203.0.113.2");
    } finally {
      await trusting.close();
    }
  });
});
