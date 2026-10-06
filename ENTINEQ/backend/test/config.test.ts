import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const base = { AGENT_BASE_URL: "https://entineq-agent.up.railway.app", INTERNAL_API_SECRET: "s".repeat(40) };

describe("loadConfig", () => {
  it("значения по умолчанию и производные адреса ядра", () => {
    const cfg = loadConfig(base);
    expect(cfg.port).toBe(8080);
    expect(cfg.agentOrigin).toBe("https://entineq-agent.up.railway.app");
    expect(cfg.agentHttpUrl).toBe("https://entineq-agent.up.railway.app/internal");
    expect(cfg.agentWsUrl).toBe("wss://entineq-agent.up.railway.app/internal/ws");
    expect(cfg.cookieSecure).toBe(false);
  });

  it("адрес с завершающим слешем и адрес в виде ws(s):// приводятся к одному виду", () => {
    expect(loadConfig({ ...base, AGENT_BASE_URL: "https://x.example.com/" }).agentOrigin).toBe("https://x.example.com");
    const fromWs = loadConfig({ ...base, AGENT_BASE_URL: "wss://x.example.com" });
    expect(fromWs.agentHttpUrl).toBe("https://x.example.com/internal");
    expect(fromWs.agentWsUrl).toBe("wss://x.example.com/internal/ws");
    expect(loadConfig({ ...base, AGENT_BASE_URL: "http://localhost:8080" }).agentWsUrl).toBe("ws://localhost:8080/internal/ws");
  });

  it("адрес с путём отвергается с подсказкой (частая ошибка - вставить …/internal/ws)", () => {
    expect(() => loadConfig({ ...base, AGENT_BASE_URL: "wss://x.example.com/internal/ws" })).toThrow(/без пути/);
  });

  it("мусор вместо адреса отвергается", () => {
    for (const bad of ["не адрес", "ftp://x.example.com", "x.example.com"]) {
      expect(() => loadConfig({ ...base, AGENT_BASE_URL: bad })).toThrow(ConfigError);
    }
  });

  it("в production обязателен ALLOWED_ORIGINS - адрес фронтенда", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production" })).toThrow(/ALLOWED_ORIGINS обязателен/);
    expect(() => loadConfig({ ...base, NODE_ENV: "production", ALLOWED_ORIGINS: "https://entineq-frontend.example.com" })).not.toThrow();
    expect(() => loadConfig(base)).not.toThrow(); // вне production - по Host, для удобства разработки
  });

  it("запасные лимиты бэкенда мягче, чем на фронтенде; адрес для прослушивания можно задать", () => {
    const cfg = loadConfig({ ...base, HOST: "127.0.0.1" });
    expect(cfg.rateLimits).toEqual({ authPerMinute: 60, wsPerMinute: 120 });
    expect(cfg.host).toBe("127.0.0.1");
    expect(loadConfig(base).host).toBeUndefined();
  });

  it("в production http допустим только для localhost и внутренней сети Railway", () => {
    const prod = { ...base, NODE_ENV: "production", ALLOWED_ORIGINS: "https://entineq-frontend.example.com" };
    expect(() => loadConfig({ ...prod, AGENT_BASE_URL: "http://entineq-agent.up.railway.app" })).toThrow(/https/);
    expect(() => loadConfig({ ...prod, AGENT_BASE_URL: "http://entineq-agent.railway.internal:8080" })).not.toThrow();
    expect(() => loadConfig({ ...prod, AGENT_BASE_URL: "http://localhost:8080" })).not.toThrow();
    expect(() => loadConfig({ ...prod, AGENT_BASE_URL: "http://agent:8080" })).not.toThrow(); // имя сервиса в docker compose
    expect(loadConfig(prod).cookieSecure).toBe(true);
  });

  it("обязательные переменные и длина секрета", () => {
    expect(() => loadConfig({ INTERNAL_API_SECRET: base.INTERNAL_API_SECRET })).toThrow(/AGENT_BASE_URL/);
    expect(() => loadConfig({ AGENT_BASE_URL: base.AGENT_BASE_URL })).toThrow(/INTERNAL_API_SECRET/);
    expect(() => loadConfig({ ...base, INTERNAL_API_SECRET: "short" })).toThrow(/32/);
  });

  it("пустые переменные считаются незаданными", () => {
    expect(() => loadConfig({ ...base, PORT: "", ALLOWED_ORIGINS: "  " })).not.toThrow();
    expect(() => loadConfig({ ...base, AGENT_BASE_URL: "" })).toThrow(/AGENT_BASE_URL/);
  });

  it("ALLOWED_ORIGINS нормализуются, мусор отвергается", () => {
    expect(loadConfig({ ...base, ALLOWED_ORIGINS: "https://a.example.com/x, http://localhost:3000" }).allowedOrigins).toEqual(["https://a.example.com", "http://localhost:3000"]);
    expect(() => loadConfig({ ...base, ALLOWED_ORIGINS: "nonsense" })).toThrow(/ALLOWED_ORIGINS/);
  });
});
