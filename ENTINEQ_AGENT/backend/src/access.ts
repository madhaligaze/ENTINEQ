import { and, eq, gte, sql } from "drizzle-orm";
import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import { freeTurns, usageEvents, users } from "./db/schema.js";
import { AppError, errors } from "./errors.js";
import type { Role } from "./types.js";
import { humanDuration } from "./usage/format.js";

/**
 * Что получает пользователь:
 * staff        - владелец и доверенные (прямая дверь): лимиты окна и месяца, терминал на Agent SDK;
 * subscription - публичный пользователь с действующей подпиской: лимиты окна и месяца, терминал в песочнице (если включена);
 * free         - публичный пользователь без подписки (гость или зарегистрированный): FREE_REQUESTS бесплатных запросов, дальше подписка.
 */
export type Plan = "free" | "subscription" | "staff";

export interface PlanUser {
  role: Role;
  freeUsed: number;
  subscribedUntil: Date | null;
}

export function planOf(user: Pick<PlanUser, "role" | "subscribedUntil">, now: Date): Plan {
  if (user.role !== "public") return "staff";
  return user.subscribedUntil !== null && user.subscribedUntil > now ? "subscription" : "free";
}

export interface FreeStatus {
  limit: number;
  used: number;
  remaining: number;
}

export function freeStatus(freeUsed: number, cfg: Pick<Config, "free">): FreeStatus {
  const limit = cfg.free.requests;
  return { limit, used: freeUsed, remaining: Math.max(0, limit - freeUsed) };
}

/** Что интерфейс узнаёт о правах пользователя (вместе с лимитами; см. UsageDto). */
export interface AccessInfo {
  plan: Plan;
  /** Только у плана free. */
  free: FreeStatus | null;
  /** У публичных пользователей; у staff - null. */
  subscription: { active: boolean; until: string | null } | null;
  /** Куда вести за подпиской (у staff не нужно). */
  subscribe: { url: string | null; hint: string };
  /** Терминал: available - можно пользоваться, subscription - есть, но нужна подписка, off - не включён. */
  terminal: "available" | "subscription" | "off";
}

/** Права пользователя; null - посетитель, у которого ещё нет ни гостевого, ни настоящего аккаунта. */
export function accessInfo(user: PlanUser | null, cfg: Pick<Config, "free" | "subscribe" | "sandbox">, now: Date): AccessInfo {
  const sandbox = cfg.sandbox.mode === "managed";
  if (user && user.role !== "public") {
    return { plan: "staff", free: null, subscription: null, subscribe: { url: null, hint: "" }, terminal: "available" };
  }
  const plan: Plan = user ? planOf(user, now) : "free";
  const active = plan === "subscription";
  return {
    plan,
    free: active ? null : freeStatus(user?.freeUsed ?? 0, cfg),
    subscription: { active, until: user?.subscribedUntil?.toISOString() ?? null },
    subscribe: cfg.subscribe,
    terminal: !sandbox ? "off" : active ? "available" : "subscription",
  };
}

/** Начало и конец суток по UTC. */
export function utcDay(at: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

const subscriptionRequired = (cfg: Pick<Config, "free">, hadSubscription: boolean) =>
  new AppError(
    "subscription_required",
    cfg.free.requests === 0
      ? "Сервис доступен по подписке. Оформите её, чтобы продолжить."
      : hadSubscription
        ? "Подписка закончилась, а бесплатные запросы уже использованы. Продлите подписку, чтобы продолжить."
        : "Бесплатные запросы закончились. Чтобы продолжить, оформите подписку.",
    402,
  );

const freeUnavailable = (reason: "ip" | "budget", resetsAt: Date, now: Date) =>
  new AppError(
    "free_unavailable",
    reason === "ip"
      ? `Бесплатные запросы с вашего адреса на сегодня закончились. Они обновятся через ${humanDuration(resetsAt.getTime() - now.getTime())}. Подписка снимает это ограничение.`
      : `Бесплатные запросы на сегодня закончились у всех: суточный запас исчерпан. Они обновятся через ${humanDuration(resetsAt.getTime() - now.getTime())}. Подписка снимает это ограничение.`,
    429,
    resetsAt.toISOString(),
  );

/** Постоянный ключ рекомендательной блокировки Postgres: все резервы бесплатных запросов проходят по одному, даже при нескольких копиях сервиса. */
const FREE_LOCK_KEY = 727_001;

/**
 * Занимает один бесплатный запрос: проверяет квоту пользователя, суточный предел адреса и суточный запас сервиса.
 * Всё в одной транзакции под общей блокировкой, поэтому одновременные запросы не проскочат лишнее.
 * Возвращает номер записи, по которой запрос можно вернуть, если ответа не получилось.
 */
export async function reserveFreeTurn(
  db: Db,
  cfg: Pick<Config, "free">,
  input: { userId: string; ipHash: string; now: Date; subscribedUntil: Date | null },
): Promise<number> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${FREE_LOCK_KEY})`);

    const [row] = await tx.select({ freeUsed: users.freeUsed }).from(users).where(eq(users.id, input.userId)).limit(1);
    if (!row) throw errors.unauthorized();
    if (row.freeUsed >= cfg.free.requests) throw subscriptionRequired(cfg, input.subscribedUntil !== null);

    const day = utcDay(input.now);
    const [fromIp] = await tx
      .select({ total: sql<string>`count(*)` })
      .from(freeTurns)
      .where(and(eq(freeTurns.ipHash, input.ipHash), gte(freeTurns.createdAt, day.start)));
    if (Number(fromIp?.total ?? 0) >= cfg.free.ipDailyCap) throw freeUnavailable("ip", day.end, input.now);

    const [spent] = await tx
      .select({ total: sql<string>`coalesce(sum(${usageEvents.costUsd}), 0)` })
      .from(usageEvents)
      .where(and(eq(usageEvents.isFree, true), gte(usageEvents.createdAt, day.start)));
    if (Number(spent?.total ?? 0) >= cfg.free.dailyBudgetUsd) throw freeUnavailable("budget", day.end, input.now);

    await tx
      .update(users)
      .set({ freeUsed: sql`${users.freeUsed} + 1` })
      .where(eq(users.id, input.userId));
    const [turn] = await tx
      .insert(freeTurns)
      .values({ userId: input.userId, ipHash: input.ipHash, createdAt: input.now })
      .returning({ id: freeTurns.id });
    return turn!.id;
  });
}

/** Возвращает бесплатный запрос, если ответа пользователь не получил (сбой, таймаут): иначе сбои сервиса «съедали» бы квоту. */
export async function releaseFreeTurn(db: Db, userId: string, turnId: number): Promise<void> {
  await db.transaction(async (tx) => {
    const removed = await tx
      .delete(freeTurns)
      .where(and(eq(freeTurns.id, turnId), eq(freeTurns.userId, userId)))
      .returning({ id: freeTurns.id });
    if (removed.length) {
      await tx
        .update(users)
        .set({ freeUsed: sql`greatest(${users.freeUsed} - 1, 0)` })
        .where(eq(users.id, userId));
    }
  });
}
