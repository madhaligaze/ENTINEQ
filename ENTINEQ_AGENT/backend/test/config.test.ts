import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const base = { INTERNAL_API_SECRET: "s".repeat(40), AGENT_RUNNER: "fake" };

describe("loadConfig", () => {
  it("применяет значения по умолчанию", () => {
    const cfg = loadConfig(base);
    expect(cfg.port).toBe(8080);
    expect(cfg.agentModel).toBe("claude-opus-5-5");
    expect(cfg.publicAgentModel).toBe("claude-opus-5-5");
    expect(cfg.sessionWindowHours).toBe(5);
    expect(cfg.defaults.public).toEqual({ monthlyBudgetUsd: 10, windowLimitUsd: 1 });
    expect(cfg.defaults.trusted).toEqual({ monthlyBudgetUsd: null, windowLimitUsd: 5 });
    expect(cfg.cookieSecure).toBe(false);
  });

  it("пустые переменные считаются незаданными (Railway любит оставлять пустые)", () => {
    const cfg = loadConfig({ ...base, OWNER_EMAIL: "", OWNER_PASSWORD: "  ", PORT: "" });
    expect(cfg.ownerEmail).toBeUndefined();
    expect(cfg.port).toBe(8080);
  });

  it("отклоняет короткий внутренний секрет", () => {
    expect(() => loadConfig({ ...base, INTERNAL_API_SECRET: "short" })).toThrow(ConfigError);
  });

  it("в production обязательны DATABASE_URL и ALLOWED_ORIGINS (адрес фронтенда), cookie становятся Secure", () => {
    const prod = { ...base, NODE_ENV: "production", DATABASE_URL: "postgres://u:p@h/db", ALLOWED_ORIGINS: "https://agent-frontend.example.com" };
    expect(() => loadConfig({ ...base, NODE_ENV: "production", ALLOWED_ORIGINS: prod.ALLOWED_ORIGINS })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ ...base, NODE_ENV: "production", DATABASE_URL: prod.DATABASE_URL })).toThrow(/ALLOWED_ORIGINS обязателен/);
    expect(loadConfig(prod).cookieSecure).toBe(true);
  });

  it("запасные лимиты бэкенда мягче, чем на фронтенде; адрес для прослушивания можно задать", () => {
    const cfg = loadConfig({ ...base, HOST: "127.0.0.1" });
    expect(cfg.rateLimits).toEqual({ loginPerMinute: 60, wsPerMinute: 120 });
    expect(cfg.host).toBe("127.0.0.1");
    expect(loadConfig(base).host).toBeUndefined();
  });

  it("настоящий раннер требует ключ Anthropic", () => {
    expect(() => loadConfig({ INTERNAL_API_SECRET: base.INTERNAL_API_SECRET })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => loadConfig({ INTERNAL_API_SECRET: base.INTERNAL_API_SECRET, ANTHROPIC_API_KEY: "sk-ant-x" })).not.toThrow();
  });

  it("OWNER_EMAIL и OWNER_PASSWORD задаются только вместе", () => {
    expect(() => loadConfig({ ...base, OWNER_EMAIL: "a@b.co" })).toThrow(/только вместе/);
    expect(() => loadConfig({ ...base, OWNER_EMAIL: "A@B.co", OWNER_PASSWORD: "long-enough-pw" })).not.toThrow();
    expect(loadConfig({ ...base, OWNER_EMAIL: "A@B.co", OWNER_PASSWORD: "long-enough-pw" }).ownerEmail).toBe("a@b.co");
  });

  it("нормализует ALLOWED_ORIGINS и отвергает мусор", () => {
    expect(loadConfig({ ...base, ALLOWED_ORIGINS: "https://a.example.com/path, http://localhost:3000" }).allowedOrigins).toEqual([
      "https://a.example.com",
      "http://localhost:3000",
    ]);
    expect(() => loadConfig({ ...base, ALLOWED_ORIGINS: "not a url" })).toThrow(/ALLOWED_ORIGINS/);
  });

  it("сообщения об ошибках понятны и по-русски", () => {
    expect(() => loadConfig({ ...base, PORT: "99999" })).toThrow(ConfigError);
    try {
      loadConfig({ ...base, OWNER_EMAIL: "не-email", OWNER_PASSWORD: "long-enough-pw" });
    } catch (error) {
      expect((error as Error).message).toContain("OWNER_EMAIL");
      expect((error as Error).message).not.toMatch(/Invalid email/);
    }
  });
});
