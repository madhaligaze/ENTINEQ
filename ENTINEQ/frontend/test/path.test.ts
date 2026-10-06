import { describe, expect, it } from "vitest";
import { isSuspiciousPath } from "../src/path.js";

describe("isSuspiciousPath (проверка пути до пересылки на бэкенд)", () => {
  it("отклоняет точки, в том числе кодированные, в любом сегменте и в любом регистре", () => {
    const bad = [
      "/api/..",
      "/api/../healthz",
      "/api/./me",
      "/api/%2e%2e/healthz",
      "/api/%2E%2E/healthz",
      "/api/.%2e/healthz",
      "/api/%2e./healthz",
      "/api/%2e/healthz",
      "/api/auth/../../healthz",
      "/api/a/%2e%2e/%2e%2e/healthz",
    ];
    for (const path of bad) expect([path, isSuspiciousPath(path)]).toEqual([path, true]);
  });

  it("отклоняет двойной слеш, обратные и закодированные слеши, нулевой байт", () => {
    const bad = ["/api//healthz", "/api/a//b", "/api/..%2fhealthz", "/api/a%2Fb", "/api/..%5chealthz", "/api/a%5Cb", "/api/..\\healthz", "/api/me%00", "/api/me%00.json"];
    for (const path of bad) expect([path, isSuspiciousPath(path)]).toEqual([path, true]);
  });

  it("пропускает обычные пути API и пути с точками внутри имён", () => {
    const good = [
      "/api/me",
      "/api/auth/login",
      "/api/conversations/00000000-0000-4000-8000-000000000000/messages",
      "/api/admin/users/00000000-0000-4000-8000-000000000000",
      "/api/a.b/c",
      "/api/a..b",
      "/api/...",
      "/api/v1.2/x",
      "/api/me/",
    ];
    for (const path of good) expect([path, isSuspiciousPath(path)]).toEqual([path, false]);
  });

  it("строку запроса не проверяет: после «?» идут данные, а не путь", () => {
    expect(isSuspiciousPath("/api/me?month=2026-10")).toBe(false);
    expect(isSuspiciousPath("/api/me?next=../../x&p=%2e%2e%2f")).toBe(false);
    expect(isSuspiciousPath("/api/me?a=//b")).toBe(false);
    expect(isSuspiciousPath("/api/..?x=1")).toBe(true); // точки в пути - отказ, даже если дальше идёт строка запроса
    expect(isSuspiciousPath("/api//?x=1")).toBe(true);
  });
});
