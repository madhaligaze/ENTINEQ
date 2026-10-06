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
  /** Модель для публичных пользователей (бесплатные запросы и подписчики). Дешевле основной: бесплатных запросов много. */
  PUBLIC_AGENT_MODEL: z.string().min(1).default("claude-sonnet-5-5"),
  /** Потолок длины одного ответа публичного чата, токенов (мысли модели входят в эту длину). */
  PUBLIC_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(256).max(64_000).default(4096),
  /** Усилие модели для публичного чата. Не задано - по умолчанию модели. Поддерживают не все модели (например, Haiku 4.5 нет). */
  PUBLIC_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  /** Сколько последних сообщений диалога отправлять модели в публичном чате и не больше скольких символов. */
  PUBLIC_HISTORY_MESSAGES: z.coerce.number().int().min(2).max(200).default(40),
  PUBLIC_HISTORY_CHARS: z.coerce.number().int().min(2_000).max(500_000).default(60_000),
  DATA_DIR: z.string().min(1).default("./.data"),

  OWNER_EMAIL: z.email().optional(),
  OWNER_PASSWORD: z.string().min(10).max(128).optional(),

  COOKIE_SECURE: flag.optional(),
  ALLOWED_ORIGINS: z.string().optional(),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),

  /** Одновременных ходов через Agent SDK (процесс на каждый ход - дорого, поэтому мало). */
  MAX_CONCURRENT_TURNS: z.coerce.number().int().min(1).max(64).default(4),
  /** Одновременных ходов публичного чата (обычный запрос к API без процесса - можно много). */
  MAX_CONCURRENT_CHAT_TURNS: z.coerce.number().int().min(1).max(1000).default(40),
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

  /** Окно сессии подписчика: длится столько часов и стартует с первого сообщения. */
  SESSION_WINDOW_HOURS: z.coerce.number().min(1).max(24).default(5),
  /** Лимиты подписчика по умолчанию (для каждого можно изменить в админке). */
  PUBLIC_DEFAULT_WINDOW_LIMIT_USD: z.coerce.number().min(0).max(100_000).default(1),
  TRUSTED_DEFAULT_WINDOW_LIMIT_USD: z.coerce.number().min(0).max(100_000).default(5),
  PUBLIC_DEFAULT_BUDGET_USD: z.coerce.number().min(0).max(1_000_000).default(10),
  TRUSTED_DEFAULT_BUDGET_USD: z.coerce.number().min(0).max(1_000_000).optional(),

  /** Бесплатная квота публичного сайта: столько запросов на пользователя, затем только подписка. */
  FREE_REQUESTS: z.coerce.number().int().min(0).max(100).default(2),
  /** Сколько бесплатных запросов в сутки (UTC) можно сделать с одного адреса: пользователь может очистить cookie и стать новым гостем. */
  FREE_IP_DAILY_CAP: z.coerce.number().int().min(1).max(100_000).default(10),
  /** Сколько всего можно потратить на бесплатные запросы за сутки (UTC), USD. Когда исчерпано, бесплатные запросы ждут до завтра. */
  FREE_DAILY_BUDGET_USD: z.coerce.number().min(0).max(1_000_000).default(5),
  /** Потолок стоимости одного бесплатного запроса, USD. */
  FREE_TURN_MAX_BUDGET_USD: z.coerce.number().min(0.001).max(100).default(0.05),
  /** Сколько новых аккаунтов (гостевых и настоящих) в сутки (UTC) можно завести с одного адреса. */
  SIGNUP_IP_DAILY_CAP: z.coerce.number().int().min(1).max(100_000).default(30),
  /** Через сколько дней без активности диалоги гостей удаляются (аккаунт гостя остаётся, пока по нему есть учёт расходов). */
  GUEST_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),

  /** Куда вести за подпиской: адрес страницы оплаты или связи с владельцем. Не задан - показывается подсказка. */
  SUBSCRIBE_URL: z.string().min(1).optional(),
  SUBSCRIBE_HINT: z.string().max(300).optional(),

  /**
   * Терминал для публичных подписчиков в изолированной песочнице (Anthropic Managed Agents): для каждого диалога
   * отдельный контейнер на стороне Anthropic, без секретов ядра. По умолчанию выключено.
   */
  SANDBOX_MODE: z.enum(["off", "managed"]).default("off"),
  MANAGED_AGENT_ID: z.string().min(1).optional(),
  MANAGED_ENVIRONMENT_ID: z.string().min(1).optional(),
  MAX_CONCURRENT_SANDBOX_TURNS: z.coerce.number().int().min(1).max(200).default(8),
  /** Потолок стоимости одного хода в песочнице, USD (расход считается по прейскуранту Anthropic, включая время работы контейнера). */
  SANDBOX_TURN_MAX_BUDGET_USD: z.coerce.number().min(0.01).max(1_000).default(1),
  SANDBOX_TURN_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(900_000),
  /** Через сколько дней без активности сессия песочницы удаляется на стороне Anthropic (диалог остаётся, терминал в нём - уже нет). */
  SANDBOX_RETENTION_DAYS: z.coerce.number().int().min(1).max(365).default(14),
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
  publicMaxOutputTokens: number;
  publicEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  publicHistoryMessages: number;
  publicHistoryChars: number;
  dataDir: string;
  ownerEmail?: string;
  ownerPassword?: string;
  cookieSecure: boolean;
  allowedOrigins: string[];
  sessionTtlDays: number;
  maxConcurrentTurns: number;
  maxConcurrentChatTurns: number;
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
  free: { requests: number; ipDailyCap: number; dailyBudgetUsd: number; turnMaxBudgetUsd: number };
  signup: { ipDailyCap: number };
  guests: { retentionDays: number };
  subscribe: { url: string | null; hint: string };
  sandbox: {
    mode: "off" | "managed";
    agentId?: string;
    environmentId?: string;
    maxConcurrentTurns: number;
    turnMaxBudgetUsd: number;
    turnTimeoutMs: number;
    retentionDays: number;
  };
}

const DEFAULT_SUBSCRIBE_HINT = "Подписку выдаёт владелец сервиса. Напишите ему и укажите email вашего аккаунта.";

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
  if (e.SANDBOX_MODE === "managed" && e.AGENT_RUNNER === "claude" && (!e.MANAGED_AGENT_ID || !e.MANAGED_ENVIRONMENT_ID)) {
    problems.push(
      "SANDBOX_MODE=managed требует MANAGED_AGENT_ID и MANAGED_ENVIRONMENT_ID (создаются один раз командой pnpm sandbox:setup).",
    );
  }

  let subscribeUrl: string | null = null;
  if (e.SUBSCRIBE_URL) {
    try {
      const url = new URL(e.SUBSCRIBE_URL.trim());
      // Адрес попадает в ссылку на странице: допускаем только http и https (иначе возможен javascript: и подобное).
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("протокол");
      subscribeUrl = url.toString();
    } catch {
      problems.push(`SUBSCRIBE_URL: «${e.SUBSCRIBE_URL}» - не адрес (нужно вида https://example.com/pay).`);
    }
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
    publicAgentModel: e.PUBLIC_AGENT_MODEL,
    publicMaxOutputTokens: e.PUBLIC_MAX_OUTPUT_TOKENS,
    publicEffort: e.PUBLIC_EFFORT,
    publicHistoryMessages: e.PUBLIC_HISTORY_MESSAGES,
    publicHistoryChars: e.PUBLIC_HISTORY_CHARS,
    dataDir: resolve(e.DATA_DIR),
    ownerEmail: e.OWNER_EMAIL?.trim().toLowerCase(),
    ownerPassword: e.OWNER_PASSWORD,
    cookieSecure: e.COOKIE_SECURE ?? e.NODE_ENV === "production",
    allowedOrigins,
    sessionTtlDays: e.SESSION_TTL_DAYS,
    maxConcurrentTurns: e.MAX_CONCURRENT_TURNS,
    maxConcurrentChatTurns: e.MAX_CONCURRENT_CHAT_TURNS,
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
    free: {
      requests: e.FREE_REQUESTS,
      ipDailyCap: e.FREE_IP_DAILY_CAP,
      dailyBudgetUsd: e.FREE_DAILY_BUDGET_USD,
      turnMaxBudgetUsd: e.FREE_TURN_MAX_BUDGET_USD,
    },
    signup: { ipDailyCap: e.SIGNUP_IP_DAILY_CAP },
    guests: { retentionDays: e.GUEST_RETENTION_DAYS },
    subscribe: { url: subscribeUrl, hint: e.SUBSCRIBE_HINT?.trim() || (subscribeUrl ? "" : DEFAULT_SUBSCRIBE_HINT) },
    sandbox: {
      mode: e.SANDBOX_MODE,
      agentId: e.MANAGED_AGENT_ID,
      environmentId: e.MANAGED_ENVIRONMENT_ID,
      maxConcurrentTurns: e.MAX_CONCURRENT_SANDBOX_TURNS,
      turnMaxBudgetUsd: e.SANDBOX_TURN_MAX_BUDGET_USD,
      turnTimeoutMs: e.SANDBOX_TURN_TIMEOUT_MS,
      retentionDays: e.SANDBOX_RETENTION_DAYS,
    },
  };
}
