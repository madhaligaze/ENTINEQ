import { z } from "zod";
import "./zod-setup.js";

export class ConfigError extends Error {
  constructor(problems: string[]) {
    super(`Ошибка конфигурации:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  /** Адрес, на котором слушать. По умолчанию — все интерфейсы, включая IPv6 (нужно для приватной сети Railway). */
  HOST: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** Сколько прокси стоит перед этим сервисом (Railway — один). Нужно, чтобы видеть настоящий IP посетителя. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),

  /** Адрес бэкенда, на который пересылаются /api и /ws. */
  BACKEND_URL: z.string().min(1, "обязателен: адрес бэкенда, например https://my-backend.up.railway.app или http://my-backend.railway.internal:8080"),
  BACKEND_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(30_000),

  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().min(1).max(100_000).default(10),
  RATE_LIMIT_WS_PER_MIN: z.coerce.number().int().min(1).max(100_000).default(30),
});

export interface Config {
  env: "development" | "test" | "production";
  port: number;
  host?: string;
  logLevel: string;
  trustProxyHops: number;
  /** Адрес бэкенда без пути и без завершающего слеша. */
  backendOrigin: string;
  backendWsUrl: string;
  backendTimeoutMs: number;
  rateLimits: { authPerMinute: number; wsPerMinute: number };
}

/**
 * Хосты, на которых допустим http: между сервисами внутри Railway трафик не выходит в интернет.
 * Имя без точки (например `backend` в docker compose) — всегда внутреннее: в публичном DNS таких имён нет.
 */
const isPrivateHost = (host: string) =>
  host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".railway.internal") || !host.includes(".");

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ""));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".") || "(env)"}: ${i.message}`));
  }
  const e = parsed.data;

  const problems: string[] = [];
  let backendOrigin = "";
  try {
    // Допускаем и ws(s):// — на случай, если вставили адрес чата.
    const url = new URL(e.BACKEND_URL.trim().replace(/^ws(s?):\/\//i, "http$1://"));
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("протокол");
    if (url.pathname !== "/" && url.pathname !== "") {
      problems.push(`BACKEND_URL: укажите только адрес сервиса без пути (например https://my-backend.up.railway.app), а не «${url.pathname}».`);
    }
    if (e.NODE_ENV === "production" && url.protocol === "http:" && !isPrivateHost(url.hostname)) {
      problems.push("BACKEND_URL: в production адрес бэкенда должен быть https:// (http допустим только для внутренней сети: *.railway.internal, localhost, имена без точки).");
    }
    backendOrigin = url.origin;
  } catch {
    problems.push(`BACKEND_URL: «${e.BACKEND_URL}» — не адрес (нужно вида https://my-backend.up.railway.app).`);
  }
  if (problems.length) throw new ConfigError(problems);

  return {
    env: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    backendOrigin,
    backendWsUrl: backendOrigin.replace(/^http/, "ws"),
    backendTimeoutMs: e.BACKEND_TIMEOUT_MS,
    rateLimits: { authPerMinute: e.RATE_LIMIT_AUTH_PER_MIN, wsPerMinute: e.RATE_LIMIT_WS_PER_MIN },
  };
}
