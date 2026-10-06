import { randomUUID } from "node:crypto";
import { and, desc, eq, gte, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { conversations, usageEvents, users, type UsageSnapshot } from "../db/schema.js";

export type Snapshot = UsageSnapshot;
type ModelTotals = Snapshot[string];

const COUNTERS = ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "costUSD"] as const;

const nonNegative = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);
const round = (value: number, digits = 8) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Приводит `modelUsage` из результата SDK к простому виду; всё непонятное отбрасывает. */
export function normalizeModelUsage(raw: unknown): Snapshot {
  const snapshot: Snapshot = {};
  if (!raw || typeof raw !== "object") return snapshot;
  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const source = value as Record<string, unknown>;
    snapshot[model] = {
      inputTokens: nonNegative(source.inputTokens),
      outputTokens: nonNegative(source.outputTokens),
      cacheReadInputTokens: nonNegative(source.cacheReadInputTokens),
      cacheCreationInputTokens: nonNegative(source.cacheCreationInputTokens),
      costUSD: nonNegative(source.costUSD),
    };
  }
  return snapshot;
}

/** Нулевой результат приходит при сбое процесса SDK — его нельзя принимать за новую «точку отсчёта». */
export function isZeroSnapshot(snapshot: Snapshot): boolean {
  return Object.values(snapshot).every((totals) => COUNTERS.every((field) => totals[field] === 0));
}

export interface ModelDelta extends ModelTotals {
  model: string;
}

const TOKEN_FIELDS = ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"] as const;
const tokenSum = (totals: ModelTotals | undefined) => (totals ? TOKEN_FIELDS.reduce((sum, field) => sum + totals[field], 0) : 0);

/** Насколько прирост токенов в итогах может быть меньше собственных токенов вызова, чтобы итоги ещё считались накопительными. */
const CUMULATIVE_TOLERANCE = 0.9;

export type UsageMode = "first" | "cumulative" | "restart";

/**
 * Накопительные ли итоги `next` относительно `prev`?
 *
 * Документация SDK: при продолжении сессии итоги берутся из сохранённого транскрипта — «если он есть».
 * Если итогов в транскрипте не оказалось (например, сессию восстановили в другом контейнере), SDK считает
 * с нуля, и вычитание прошлых итогов дало бы потерю расхода. Различаем так: `callTokens` (поле `usage`
 * результата) — токены именно этого вызова. При накопительных итогах их прирост не меньше `callTokens`;
 * если он заметно меньше — итоги начались заново.
 */
export function classifyUsage(prev: Snapshot, next: Snapshot, callTokens?: number): UsageMode {
  if (Object.keys(prev).length === 0) return "first";
  for (const model of Object.keys(prev)) if (!(model in next)) return "restart";
  let growth = 0;
  for (const [model, now] of Object.entries(next)) {
    const before = prev[model];
    if (before && COUNTERS.some((field) => now[field] < before[field] - 1e-9)) return "restart";
    growth += tokenSum(now) - tokenSum(before);
  }
  if (callTokens !== undefined && callTokens > 0 && growth < callTokens * CUMULATIVE_TOLERANCE) return "restart";
  return "cumulative";
}

/**
 * Расход за ход из итогов SDK. Накопительные итоги → разница с прошлыми; начатые заново → итоги целиком.
 */
export function diffUsage(prev: Snapshot, next: Snapshot, callTokens?: number): ModelDelta[] {
  const mode = classifyUsage(prev, next, callTokens);
  const deltas: ModelDelta[] = [];
  for (const [model, now] of Object.entries(next)) {
    const base = mode === "cumulative" ? prev[model] : undefined;
    const delta: ModelDelta = {
      model,
      inputTokens: now.inputTokens - (base?.inputTokens ?? 0),
      outputTokens: now.outputTokens - (base?.outputTokens ?? 0),
      cacheReadInputTokens: now.cacheReadInputTokens - (base?.cacheReadInputTokens ?? 0),
      cacheCreationInputTokens: now.cacheCreationInputTokens - (base?.cacheCreationInputTokens ?? 0),
      costUSD: round(now.costUSD - (base?.costUSD ?? 0)),
    };
    if (COUNTERS.some((field) => delta[field] > 0)) deltas.push(delta);
  }
  return deltas;
}

export interface MonthBounds {
  key: string;
  start: Date;
  end: Date;
}

/** Календарный месяц по UTC. */
export function monthBounds(at: Date): MonthBounds {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  return {
    key: `${year}-${String(month + 1).padStart(2, "0")}`,
    start: new Date(Date.UTC(year, month, 1)),
    end: new Date(Date.UTC(year, month + 1, 1)),
  };
}

export function parseMonthKey(key: string): MonthBounds | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(key);
  if (!match) return null;
  return monthBounds(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1)));
}

export interface LimitStatus {
  month: string;
  monthResetsAt: Date;
  monthSpentUsd: number;
  monthBudgetUsd: number | null;
  windowHours: number;
  windowActive: boolean;
  windowStartedAt: Date | null;
  windowResetsAt: Date | null;
  windowSpentUsd: number;
  windowLimitUsd: number | null;
}

interface LimitedUser {
  id: string;
  monthlyBudgetUsd: string | null;
  windowLimitUsd: string | null;
  windowStartedAt: Date | null;
}

const toNumber = (value: string | null) => (value === null ? null : Number(value));

export async function monthSpend(db: Db, userId: string, bounds: MonthBounds): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)` })
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, userId), gte(usageEvents.createdAt, bounds.start), lt(usageEvents.createdAt, bounds.end)));
  return Number(row?.total ?? 0);
}

export async function windowSpend(db: Db, userId: string, windowStart: Date): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)` })
    .from(usageEvents)
    .where(and(eq(usageEvents.userId, userId), gte(usageEvents.windowStart, windowStart)));
  return Number(row?.total ?? 0);
}

export async function getLimitStatus(db: Db, user: LimitedUser, windowHours: number, now: Date): Promise<LimitStatus> {
  const bounds = monthBounds(now);
  const windowEnd = user.windowStartedAt ? new Date(user.windowStartedAt.getTime() + windowHours * 3_600_000) : null;
  const windowActive = windowEnd !== null && now < windowEnd;
  return {
    month: bounds.key,
    monthResetsAt: bounds.end,
    monthSpentUsd: await monthSpend(db, user.id, bounds),
    monthBudgetUsd: toNumber(user.monthlyBudgetUsd),
    windowHours,
    windowActive,
    windowStartedAt: windowActive ? user.windowStartedAt : null,
    windowResetsAt: windowActive ? windowEnd : null,
    windowSpentUsd: windowActive && user.windowStartedAt ? await windowSpend(db, user.id, user.windowStartedAt) : 0,
    windowLimitUsd: toNumber(user.windowLimitUsd),
  };
}

export interface UsageDto {
  month: string;
  monthSpentUsd: number;
  monthBudgetUsd: number | null;
  monthResetsAt: string;
  window: {
    hours: number;
    active: boolean;
    startedAt: string | null;
    resetsAt: string | null;
    spentUsd: number;
    limitUsd: number | null;
  };
}

export function usageDto(status: LimitStatus): UsageDto {
  return {
    month: status.month,
    monthSpentUsd: round(status.monthSpentUsd, 6),
    monthBudgetUsd: status.monthBudgetUsd,
    monthResetsAt: status.monthResetsAt.toISOString(),
    window: {
      hours: status.windowHours,
      active: status.windowActive,
      startedAt: status.windowStartedAt?.toISOString() ?? null,
      resetsAt: status.windowResetsAt?.toISOString() ?? null,
      spentUsd: round(status.windowSpentUsd, 6),
      limitUsd: status.windowLimitUsd,
    },
  };
}

export function humanDuration(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes >= 48 * 60) return `${Math.ceil(minutes / (24 * 60))} дн.`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h} ч ${m} мин`;
  return h ? `${h} ч` : `${m} мин`;
}

const money = (value: number) => `$${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;

export interface Block {
  code: "budget_exceeded" | "session_limit";
  message: string;
  resetsAt: Date | null;
}

/** Решает, можно ли начинать новый ход. Месячный лимит важнее: он сбрасывается позже окна. */
export function blockReason(status: LimitStatus, now: Date): Block | null {
  if (status.monthBudgetUsd !== null && status.monthSpentUsd >= status.monthBudgetUsd) {
    return {
      code: "budget_exceeded",
      message: `Месячный лимит исчерпан: потрачено ${money(status.monthSpentUsd)} из ${money(status.monthBudgetUsd)}. Он обновится через ${humanDuration(status.monthResetsAt.getTime() - now.getTime())}.`,
      resetsAt: status.monthResetsAt,
    };
  }
  const limit = status.windowLimitUsd;
  if (limit !== null) {
    if (status.windowActive && status.windowResetsAt && status.windowSpentUsd >= limit) {
      return {
        code: "session_limit",
        message: `Лимит сессии исчерпан (${money(status.windowSpentUsd)} из ${money(limit)}). Новое окно откроется через ${humanDuration(status.windowResetsAt.getTime() - now.getTime())}.`,
        resetsAt: status.windowResetsAt,
      };
    }
    if (limit <= 0) {
      return { code: "session_limit", message: "Для вашего аккаунта лимит сессии равен нулю. Обратитесь к администратору.", resetsAt: null };
    }
  }
  return null;
}

/** Сколько ещё можно потратить за один ход, не выходя за лимиты (нужно для maxBudgetUsd). */
export function turnBudgetUsd(status: LimitStatus): number | undefined {
  const caps: number[] = [];
  if (status.monthBudgetUsd !== null) caps.push(status.monthBudgetUsd - status.monthSpentUsd);
  if (status.windowLimitUsd !== null) caps.push(status.windowLimitUsd - (status.windowActive ? status.windowSpentUsd : 0));
  return caps.length ? Math.max(0.0001, Math.min(...caps)) : undefined;
}

/**
 * Открывает окно сессии, если прошлое закончилось (или его не было). Окно стартует с первого
 * сообщения и длится фиксированное время; запрос атомарный — две вкладки не откроют два окна.
 */
export async function openWindow(db: Db, userId: string, windowHours: number, now: Date): Promise<Date> {
  const expiredBefore = new Date(now.getTime() - windowHours * 3_600_000);
  const [opened] = await db
    .update(users)
    .set({ windowStartedAt: now })
    .where(and(eq(users.id, userId), or(isNull(users.windowStartedAt), lte(users.windowStartedAt, expiredBefore))))
    .returning({ windowStartedAt: users.windowStartedAt });
  if (opened?.windowStartedAt) return opened.windowStartedAt;
  const [current] = await db.select({ windowStartedAt: users.windowStartedAt }).from(users).where(eq(users.id, userId));
  if (!current?.windowStartedAt) throw new Error("Не удалось открыть окно сессии");
  return current.windowStartedAt;
}

export async function recordTurnUsage(
  db: Db,
  input: {
    userId: string;
    conversationId: string;
    outcome: string;
    next: Snapshot;
    sessionChanged: boolean;
    windowStart: Date;
    /** Момент записи (по тем же часам, что и лимиты). */
    at: Date;
    /** Токены самого этого вызова (поле usage результата SDK) — по ним определяется, накопительные ли итоги. */
    callTokens?: number;
  },
): Promise<{ deltaUsd: number; mode: UsageMode | "ignored" }> {
  if (isZeroSnapshot(input.next)) return { deltaUsd: 0, mode: "ignored" };
  return db.transaction(async (tx) => {
    const [conversation] = await tx
      .select({ snapshot: conversations.usageSnapshot })
      .from(conversations)
      .where(eq(conversations.id, input.conversationId))
      .for("update");
    const previous: Snapshot = input.sessionChanged ? {} : (conversation?.snapshot ?? {});
    const mode = classifyUsage(previous, input.next, input.callTokens);
    const deltas = diffUsage(previous, input.next, input.callTokens);
    if (deltas.length) {
      const turnId = randomUUID();
      await tx.insert(usageEvents).values(
        deltas.map((delta) => ({
          turnId,
          userId: input.userId,
          conversationId: input.conversationId,
          model: delta.model,
          inputTokens: Math.round(delta.inputTokens),
          outputTokens: Math.round(delta.outputTokens),
          cacheReadTokens: Math.round(delta.cacheReadInputTokens),
          cacheCreationTokens: Math.round(delta.cacheCreationInputTokens),
          costUsd: delta.costUSD.toFixed(8),
          outcome: input.outcome,
          windowStart: input.windowStart,
          createdAt: input.at,
        })),
      );
    }
    await tx.update(conversations).set({ usageSnapshot: input.next, updatedAt: input.at }).where(eq(conversations.id, input.conversationId));
    return { deltaUsd: round(deltas.reduce((sum, delta) => sum + delta.costUSD, 0)), mode };
  });
}

export interface UsageReportRow {
  userId: string;
  email: string;
  role: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
}

export async function usageReport(db: Db, bounds: MonthBounds): Promise<{ rows: UsageReportRow[]; totalUsd: number }> {
  const cost = sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)`;
  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      role: users.role,
      turns: sql<string>`count(distinct ${usageEvents.turnId})`,
      inputTokens: sql<string>`coalesce(sum(${usageEvents.inputTokens}), 0)`,
      outputTokens: sql<string>`coalesce(sum(${usageEvents.outputTokens}), 0)`,
      cacheReadTokens: sql<string>`coalesce(sum(${usageEvents.cacheReadTokens}), 0)`,
      cacheCreationTokens: sql<string>`coalesce(sum(${usageEvents.cacheCreationTokens}), 0)`,
      costUsd: cost,
    })
    .from(users)
    .leftJoin(
      usageEvents,
      and(eq(usageEvents.userId, users.id), gte(usageEvents.createdAt, bounds.start), lt(usageEvents.createdAt, bounds.end)),
    )
    .groupBy(users.id)
    .orderBy(desc(cost), users.email);
  const mapped = rows.map((row) => ({
    userId: row.userId,
    email: row.email,
    role: row.role,
    turns: Number(row.turns),
    inputTokens: Number(row.inputTokens),
    outputTokens: Number(row.outputTokens),
    cacheReadTokens: Number(row.cacheReadTokens),
    cacheCreationTokens: Number(row.cacheCreationTokens),
    costUsd: round(Number(row.costUsd), 6),
  }));
  return { rows: mapped, totalUsd: round(mapped.reduce((sum, row) => sum + row.costUsd, 0), 6) };
}
