import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";
import { listen } from "../src/listen.js";

const base = { BACKEND_URL: "https://my-backend.up.railway.app" };

describe("loadConfig", () => {
  it("значения по умолчанию и производные адреса", () => {
    const cfg = loadConfig(base);
    expect(cfg.port).toBe(8080);
    expect(cfg.trustProxyHops).toBe(1);
    expect(cfg.backendOrigin).toBe("https://my-backend.up.railway.app");
    expect(cfg.backendWsUrl).toBe("wss://my-backend.up.railway.app");
    expect(cfg.rateLimits).toEqual({ authPerMinute: 10, wsPerMinute: 30 });
  });

  it("адрес с завершающим слешем и в виде ws(s):// приводится к одному виду", () => {
    expect(loadConfig({ BACKEND_URL: "https://x.example.com/" }).backendOrigin).toBe("https://x.example.com");
    expect(loadConfig({ BACKEND_URL: "wss://x.example.com" }).backendOrigin).toBe("https://x.example.com");
    expect(loadConfig({ BACKEND_URL: "http://localhost:3000" }).backendWsUrl).toBe("ws://localhost:3000");
  });

  it("адрес с путём и мусор отвергаются", () => {
    expect(() => loadConfig({ BACKEND_URL: "https://x.example.com/api" })).toThrow(/без пути/);
    for (const bad of ["не адрес", "ftp://x.example.com", "x.example.com"]) expect(() => loadConfig({ BACKEND_URL: bad })).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/BACKEND_URL/);
  });

  it("в production http допустим только во внутренней сети", () => {
    const prod = { NODE_ENV: "production" };
    expect(() => loadConfig({ ...prod, BACKEND_URL: "http://my-backend.up.railway.app" })).toThrow(/https/);
    for (const ok of ["http://my-backend.railway.internal:8080", "http://localhost:8080", "http://backend:8080", "https://my-backend.up.railway.app"]) {
      expect(() => loadConfig({ ...prod, BACKEND_URL: ok })).not.toThrow();
    }
  });

  it("пустые переменные считаются незаданными", () => {
    expect(loadConfig({ ...base, PORT: "", HOST: "  " }).port).toBe(8080);
  });
});

describe("listen - запасной адрес для систем без IPv6", () => {
  const fakeApp = (behaviour: (host: string) => Error | undefined) => {
    const attempts: string[] = [];
    const app = {
      listen: async ({ host }: { host: string }) => {
        attempts.push(host);
        const error = behaviour(host);
        if (error) throw error;
      },
    } as unknown as FastifyInstance;
    return { app, attempts };
  };
  const errno = (code: string) => Object.assign(new Error(code), { code });

  it("сначала `::`, при отсутствии IPv6 - `0.0.0.0`", async () => {
    const { app, attempts } = fakeApp((host) => (host === "::" ? errno("EAFNOSUPPORT") : undefined));
    expect(await listen(app, 8080)).toBe("0.0.0.0");
    expect(attempts).toEqual(["::", "0.0.0.0"]);
  });

  it("если `::` доступен - другие адреса не пробуются", async () => {
    const { app, attempts } = fakeApp(() => undefined);
    expect(await listen(app, 8080)).toBe("::");
    expect(attempts).toEqual(["::"]);
  });

  it("занятый порт - настоящая ошибка, запасной адрес её не маскирует", async () => {
    const { app, attempts } = fakeApp(() => errno("EADDRINUSE"));
    await expect(listen(app, 8080)).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(attempts).toEqual(["::"]);
  });

  it("явно заданный адрес используется как есть", async () => {
    const { app, attempts } = fakeApp(() => undefined);
    expect(await listen(app, 8080, "127.0.0.1")).toBe("127.0.0.1");
    expect(attempts).toEqual(["127.0.0.1"]);
  });
});
