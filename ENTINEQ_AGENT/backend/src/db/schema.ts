import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["owner", "trusted", "public"]);

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
/** Деньги в долларах. Хранятся как numeric, в коде приходят строкой. */
const usd = (name: string) => numeric(name, { precision: 14, scale: 6 });

/** Накопительные итоги по моделям, как их отдаёт SDK (см. usage/ledger.ts). */
export type UsageSnapshot = Record<
  string,
  {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheCreationInputTokens: number;
    costUSD: number;
  }
>;

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Всегда в нижнем регистре и без пробелов по краям. null - гость: аккаунт без входа, создаётся при первом сообщении. */
    email: text("email").unique(),
    passwordHash: text("password_hash"),
    role: userRole("role").notNull(),
    /** Лимит расходов на календарный месяц (UTC) для подписчика. null - без лимита. */
    monthlyBudgetUsd: usd("monthly_budget_usd"),
    /** Лимит расходов на одно окно сессии (как 5-часовой лимит у подписок) для подписчика. null - без лимита. */
    windowLimitUsd: usd("window_limit_usd"),
    /** Начало текущего окна - время первого сообщения после окончания прошлого окна. */
    windowStartedAt: ts("window_started_at"),
    isActive: boolean("is_active").notNull().default(true),
    failedLogins: integer("failed_logins").notNull().default(0),
    lockedUntil: ts("locked_until"),
    /** Сколько бесплатных запросов уже потрачено (предел - FREE_REQUESTS). Гость при регистрации сохраняет счётчик. */
    freeUsed: integer("free_used").notNull().default(0),
    /** Подписка действует до этого момента; null - подписки не было. Выдаёт владелец в админке. */
    subscribedUntil: ts("subscribed_until"),
    /** HMAC адреса, с которого создан аккаунт: нужен для предела числа новых гостей с одного адреса. Сам адрес не хранится. */
    signupIpHash: text("signup_ip_hash"),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    // Гость - аккаунт без email и без пароля, всегда публичный; настоящий аккаунт имеет и то и другое.
    check("users_credentials_pair", sql`(${t.email} is null) = (${t.passwordHash} is null)`),
    check("users_guest_is_public", sql`${t.email} is not null or ${t.role} = 'public'`),
    index("users_signup_ip_idx").on(t.signupIpHash, t.createdAt),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** sha256 от токена; сам токен хранится только в cookie у пользователя. */
    tokenHash: text("token_hash").notNull().unique(),
    entry: text("entry").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    lastUsedAt: ts("last_used_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
  },
  (t) => [index("auth_sessions_user_idx").on(t.userId), index("auth_sessions_expires_idx").on(t.expiresAt)],
);

/**
 * Бесплатные запросы: по строке на каждый занятый запрос. Нужны для предела числа бесплатных запросов с одного адреса
 * в сутки (пользователь может очистить cookie и стать новым гостем, а адрес остаётся тем же).
 */
export const freeTurns = pgTable(
  "free_turns",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** HMAC адреса (для IPv6 - сети /64). */
    ipHash: text("ip_hash").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("free_turns_ip_idx").on(t.ipHash, t.createdAt)],
);

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    entry: text("entry").notNull(),
    title: text("title").notNull(),
    /**
     * Чем ведётся диалог: agent - Claude Agent SDK в контейнере ядра (владелец и доверенные),
     * chat - обычный чат через Messages API без инструментов (публичные),
     * managed - агент с терминалом в изолированной песочнице Anthropic Managed Agents (подписчики).
     * Выбирается при создании диалога и дальше не меняется.
     */
    engine: text("engine").notNull().default("agent"),
    /** Идентификатор сессии движка: сессия Agent SDK (resume) либо сессия Managed Agents. У чата пусто. */
    sdkSessionId: text("sdk_session_id"),
    /** Последние накопительные итоги из SDK - база для вычисления расхода за ход. */
    usageSnapshot: jsonb("usage_snapshot").$type<UsageSnapshot>().notNull().default({}),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("conversations_user_updated_idx").on(t.userId, t.updatedAt)],
);

export const messages = pgTable(
  "messages",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** user | assistant | tool */
    role: text("role").notNull(),
    content: text("content").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("messages_conversation_idx").on(t.conversationId, t.id)],
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** Все строки одного хода (по моделям) делят один turn_id. */
    turnId: uuid("turn_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    model: text("model").notNull(),
    inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
    outputTokens: bigint("output_tokens", { mode: "number" }).notNull().default(0),
    cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
    cacheCreationTokens: bigint("cache_creation_tokens", { mode: "number" }).notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 16, scale: 8 }).notNull(),
    /** success или подтип ошибки SDK (error_max_turns и т.д.). */
    outcome: text("outcome").notNull(),
    /** Начало окна сессии, в котором начался ход: к нему относится расход. У бесплатных запросов окна нет - там момент хода. */
    windowStart: ts("window_start").notNull(),
    /** Ход оплачен из бесплатной квоты: из таких расходов складывается суточный запас бесплатных запросов (FREE_DAILY_BUDGET_USD). */
    isFree: boolean("is_free").notNull().default(false),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("usage_events_user_created_idx").on(t.userId, t.createdAt),
    index("usage_events_user_window_idx").on(t.userId, t.windowStart),
    index("usage_events_free_idx")
      .on(t.createdAt)
      .where(sql`${t.isFree}`),
  ],
);

/** Транскрипты сессий Agent SDK. Хранятся в БД, потому что диск на Railway сбрасывается при деплое. */
export const sdkSessionEntries = pgTable(
  "sdk_session_entries",
  {
    seq: bigserial("seq", { mode: "number" }).primaryKey(),
    projectKey: text("project_key").notNull(),
    sessionId: text("session_id").notNull(),
    /** Пустая строка - основной транскрипт; иначе путь субагента. */
    subpath: text("subpath").notNull().default(""),
    uuid: text("uuid"),
    entry: jsonb("entry").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("sdk_session_entries_key_idx").on(t.projectKey, t.sessionId, t.subpath, t.seq),
    uniqueIndex("sdk_session_entries_uuid_uq")
      .on(t.projectKey, t.sessionId, t.subpath, t.uuid)
      .where(sql`${t.uuid} is not null`),
  ],
);
