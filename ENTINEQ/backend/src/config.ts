import { z } from "zod";
import "./zod-setup.js";

export class ConfigError extends Error {
  constructor(problems: string[]) {
    super(`Ошибка конфигурации:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

const flag = z.enum(["true", "false", "1", "0"]).transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  /** Адрес, на котором слушать. По умолчанию - все интерфейсы, включая IPv6 (нужно для приватной сети Railway). */
  HOST: z.string().min(1).optional(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** Сколько прокси стоит перед бэкендом (фронтенд-сервис - один). Нужно для определения IP посетителя. */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(1),

  /** Адрес ядра ENTINEQ_AGENT, например https://entineq-agent-production.up.railway.app */
  AGENT_BASE_URL: z.string().min(1, "обязателен: адрес ENTINEQ_AGENT, например https://entineq-agent.up.railway.app"),
  INTERNAL_API_SECRET: z.string().min(32, "минимум 32 символа и точно такой же, как в ENTINEQ_AGENT (сгенерируй: pnpm gen:secret)"),
  AGENT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),

  COOKIE_SECURE: flag.optional(),
  ALLOWED_ORIGINS: z.string().optional(),
  /**
   * Запасной предел на бэкенде (попыток входа/регистрации и открытий чата в минуту с одного IP). Основной (строгий)
   * предел стоит на фронтенд-сервисе, где виден настоящий IP посетителя; здесь он мягче, чтобы ошибка в
   * TRUST_PROXY_HOPS не заблокировала всех сразу.
   */
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().min(1).max(100_000).default(60),
  RATE_LIMIT_WS_PER_MIN: z.coerce.number().int().min(1).max(100_000).default(120),
});

export interface Config {
  env: "development" | "test" | "production";
  port: number;
  host?: string;
  logLevel: string;
  trustProxyHops: number;
  /** Адрес ядра без пути и без завершающего слеша. */
  agentOrigin: string;
  agentHttpUrl: string;
  agentWsUrl: string;
  internalApiSecret: string;
  agentTimeoutMs: number;
  cookieSecure: boolean;
  allowedOrigins: string[];
  rateLimits: { authPerMinute: number; wsPerMinute: number };
}

/**
 * Хосты, на которых допустим http: общий секрет по нему не уходит в открытый интернет.
 * Имя без точки (например `agent` в docker compose) - всегда внутреннее: в публичном DNS таких имён нет.
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

  let agentOrigin = "";
  try {
    // Допускаем и ws(s):// - на случай, если вставили адрес из старой инструкции.
    const url = new URL(e.AGENT_BASE_URL.trim().replace(/^ws(s?):\/\//i, "http$1://"));
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("протокол");
    if (url.pathname !== "/" && url.pathname !== "") {
      problems.push(`AGENT_BASE_URL: укажите только адрес сайта без пути (например https://entineq-agent.up.railway.app), а не «${url.pathname}».`);
    }
    if (e.NODE_ENV === "production" && url.protocol === "http:" && !isPrivateHost(url.hostname)) {
      problems.push("AGENT_BASE_URL: в production адрес ядра должен быть https:// - по http общий секрет уходил бы в открытом виде.");
    }
    agentOrigin = url.origin;
  } catch {
    problems.push(`AGENT_BASE_URL: «${e.AGENT_BASE_URL}» - не адрес (нужно вида https://entineq-agent.up.railway.app).`);
  }

  const allowedOrigins: string[] = [];
  for (const raw of (e.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    try {
      allowedOrigins.push(new URL(raw).origin);
    } catch {
      problems.push(`ALLOWED_ORIGINS: «${raw}» - не адрес (нужно вида https://example.com).`);
    }
  }
  if (e.NODE_ENV === "production" && allowedOrigins.length === 0) {
    problems.push(
      "ALLOWED_ORIGINS обязателен в production: публичный адрес фронтенда, например https://entineq-frontend.up.railway.app " +
        "(браузер шлёт именно его в заголовке Origin; без него вход и чат будут отклонены как «запрос с чужого сайта»).",
    );
  }
  if (problems.length) throw new ConfigError(problems);

  return {
    env: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    trustProxyHops: e.TRUST_PROXY_HOPS,
    agentOrigin,
    agentHttpUrl: `${agentOrigin}/internal`,
    agentWsUrl: `${agentOrigin.replace(/^http/, "ws")}/internal/ws`,
    internalApiSecret: e.INTERNAL_API_SECRET,
    agentTimeoutMs: e.AGENT_TIMEOUT_MS,
    cookieSecure: e.COOKIE_SECURE ?? e.NODE_ENV === "production",
    allowedOrigins,
    rateLimits: { authPerMinute: e.RATE_LIMIT_AUTH_PER_MIN, wsPerMinute: e.RATE_LIMIT_WS_PER_MIN },
  };
}
