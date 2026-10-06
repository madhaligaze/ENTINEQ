import { resolve } from "node:path";
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

  DATABASE_URL: z.string().min(1).optional(),
  DATABASE_SSL: flag.default(false),

  INTERNAL_API_SECRET: z.string().min(32, "минимум 32 символа (сгенерируй командой: pnpm gen:secret)"),

  AGENT_RUNNER: z.enum(["claude", "fake"]).default("claude"),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  AGENT_MODEL: z.string().min(1).default("claude-opus-5-5"),
  PUBLIC_AGENT_MODEL: z.string().min(1).optional(),
  DATA_DIR: z.string().min(1).default("./.data"),

  OWNER_EMAIL: z.email().optional(),
  OWNER_PASSWORD: z.string().min(10).max(128).optional(),

  COOKIE_SECURE: flag.optional(),
  ALLOWED_ORIGINS: z.string().optional(),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  MAX_CONCURRENT_TURNS: z.coerce.number().int().min(1).max(64).default(4),
  TURN_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(600_000),
  TRUSTED_MAX_TURNS: z.coerce.number().int().min(1).max(200).default(50),
  PUBLIC_MAX_TURNS: z.coerce.number().int().min(1).max(50).default(5),
  /**
   * Запасной предел на бэкенде: попыток входа и открытий WebSocket в минуту с одного IP. Основной (строгий)
   * предел стоит на фронтенд-сервисе, где виден настоящий IP посетителя; здесь он мягче, чтобы ошибка в
   * TRUST_PROXY_HOPS не заблокировала всех сразу (каждый аккаунт и так блокируется после 8 неудачных входов).
   */
  RATE_LIMIT_LOGIN_PER_MIN: z.coerce.number().int().min(1).max(100_000).default(60),
  RATE_LIMIT_WS_PER_MIN: z.coerce.number().int().min(1).max(100_000).default(120),
  /** Страховка от «убежавшего» агента: потолок стоимости одного запроса, USD. */
  TURN_MAX_BUDGET_USD: z.coerce.number().min(0.01).max(1_000).default(10),

  /** Окно сессии: длится столько часов и стартует с первого сообщения. */
  SESSION_WINDOW_HOURS: z.coerce.number().min(1).max(24).default(5),
  PUBLIC_DEFAULT_WINDOW_LIMIT_USD: z.coerce.number().min(0).max(100_000).default(1),
  TRUSTED_DEFAULT_WINDOW_LIMIT_USD: z.coerce.number().min(0).max(100_000).default(5),
  PUBLIC_DEFAULT_BUDGET_USD: z.coerce.number().min(0).max(1_000_000).default(10),
  TRUSTED_DEFAULT_BUDGET_USD: z.coerce.number().min(0).max(1_000_000).optional(),
});

export interface Config {
  env: "development" | "test" | "production";
  port: number;
  host?: string;
  logLevel: string;
  trustProxyHops: number;
  databaseUrl?: string;
  databaseSsl: boolean;
  internalApiSecret: string;
  agentRunner: "claude" | "fake";
  anthropicApiKey?: string;
  agentModel: string;
  publicAgentModel: string;
  dataDir: string;
  ownerEmail?: string;
  ownerPassword?: string;
  cookieSecure: boolean;
  allowedOrigins: string[];
  sessionTtlDays: number;
  maxConcurrentTurns: number;
  turnTimeoutMs: number;
  trustedMaxTurns: number;
  publicMaxTurns: number;
  turnMaxBudgetUsd: number;
  rateLimits: { loginPerMinute: number; wsPerMinute: number };
  sessionWindowHours: number;
  defaults: {
    public: { monthlyBudgetUsd: number | null; windowLimitUsd: number | null };
    trusted: { monthlyBudgetUsd: number | null; windowLimitUsd: number | null };
  };
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  // Пустая переменная (например, OWNER_PASSWORD=) считается незаданной.
  const cleaned = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined && value.trim() !== ""),
  );
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".") || "(env)"}: ${i.message}`));
  }
  const e = parsed.data;

  const problems: string[] = [];
  if (e.NODE_ENV === "production" && !e.DATABASE_URL) {
    problems.push("DATABASE_URL обязателен в production (Railway: добавь сервис PostgreSQL и подключи его переменную).");
  }
  if (e.AGENT_RUNNER === "claude" && !e.ANTHROPIC_API_KEY) {
    problems.push("ANTHROPIC_API_KEY обязателен при AGENT_RUNNER=claude.");
  }
  if (Boolean(e.OWNER_EMAIL) !== Boolean(e.OWNER_PASSWORD)) {
    problems.push("OWNER_EMAIL и OWNER_PASSWORD задаются только вместе.");
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
      "ALLOWED_ORIGINS обязателен в production: публичный адрес фронтенда, например https://entineq-agent-frontend.up.railway.app " +
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
    databaseUrl: e.DATABASE_URL,
    databaseSsl: e.DATABASE_SSL,
    internalApiSecret: e.INTERNAL_API_SECRET,
    agentRunner: e.AGENT_RUNNER,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    agentModel: e.AGENT_MODEL,
    publicAgentModel: e.PUBLIC_AGENT_MODEL ?? e.AGENT_MODEL,
    dataDir: resolve(e.DATA_DIR),
    ownerEmail: e.OWNER_EMAIL?.trim().toLowerCase(),
    ownerPassword: e.OWNER_PASSWORD,
    cookieSecure: e.COOKIE_SECURE ?? e.NODE_ENV === "production",
    allowedOrigins,
    sessionTtlDays: e.SESSION_TTL_DAYS,
    maxConcurrentTurns: e.MAX_CONCURRENT_TURNS,
    turnTimeoutMs: e.TURN_TIMEOUT_MS,
    trustedMaxTurns: e.TRUSTED_MAX_TURNS,
    publicMaxTurns: e.PUBLIC_MAX_TURNS,
    turnMaxBudgetUsd: e.TURN_MAX_BUDGET_USD,
    rateLimits: { loginPerMinute: e.RATE_LIMIT_LOGIN_PER_MIN, wsPerMinute: e.RATE_LIMIT_WS_PER_MIN },
    sessionWindowHours: e.SESSION_WINDOW_HOURS,
    defaults: {
      public: { monthlyBudgetUsd: e.PUBLIC_DEFAULT_BUDGET_USD, windowLimitUsd: e.PUBLIC_DEFAULT_WINDOW_LIMIT_USD },
      trusted: { monthlyBudgetUsd: e.TRUSTED_DEFAULT_BUDGET_USD ?? null, windowLimitUsd: e.TRUSTED_DEFAULT_WINDOW_LIMIT_USD },
    },
  };
}
