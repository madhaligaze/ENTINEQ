import { asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { planOf } from "../access.js";
import { users } from "../db/schema.js";
import { errors } from "../errors.js";
import { createUserBody, idParam, monthQuery, patchUserBody } from "../schemas.js";
import type { Actor } from "../types.js";
import { monthBounds, parseMonthKey, usageReport } from "../usage/ledger.js";
import type { AppContext } from "./context.js";

const usd = (value: number | null) => (value === null ? null : value.toFixed(6));
const num = (value: string | null) => (value === null ? null : Number(value));

/** Администрирование: только для владельца. */
export function registerAdmin(scope: FastifyInstance, ctx: AppContext, ownerOf: (req: FastifyRequest) => Promise<Actor>): void {
  const { db, auth, cfg } = ctx;

  const view = (row: typeof users.$inferSelect, spent?: number) => ({
    id: row.id,
    email: row.email ?? "",
    role: row.role,
    isActive: row.isActive,
    monthlyBudgetUsd: num(row.monthlyBudgetUsd),
    windowLimitUsd: num(row.windowLimitUsd),
    plan: planOf(row, new Date()),
    freeUsed: row.freeUsed,
    subscribedUntil: row.subscribedUntil?.toISOString() ?? null,
    ...(spent === undefined ? {} : { spentThisMonthUsd: spent }),
    createdAt: row.createdAt.toISOString(),
  });

  scope.get("/admin/users", async (req) => {
    await ownerOf(req);
    // Гости (аккаунты без почты) в список не попадают: их много и управлять ими нечем. Показываем только их число.
    const rows = await db.select().from(users).where(isNotNull(users.email)).orderBy(asc(users.createdAt));
    const [guests] = await db.select({ total: sql<string>`count(*)` }).from(users).where(isNull(users.email));
    const { rows: report } = await usageReport(db, monthBounds(new Date()));
    const spent = new Map(report.map((row) => [row.userId, row.costUsd]));
    return {
      users: rows.map((row) => view(row, spent.get(row.id) ?? 0)),
      guests: Number(guests?.total ?? 0),
      freeRequests: cfg.free.requests,
    };
  });

  scope.post("/admin/users", async (req, reply) => {
    await ownerOf(req);
    const body = createUserBody.parse(req.body);
    const defaults = cfg.defaults[body.role];
    const user = await auth.createUser({
      email: body.email,
      password: body.password,
      role: body.role,
      monthlyBudgetUsd: body.monthlyBudgetUsd === undefined ? defaults.monthlyBudgetUsd : body.monthlyBudgetUsd,
      windowLimitUsd: body.windowLimitUsd === undefined ? defaults.windowLimitUsd : body.windowLimitUsd,
    });
    return reply.code(201).send({ user });
  });

  scope.patch("/admin/users/:id", async (req) => {
    const actor = await ownerOf(req);
    const { id } = idParam.parse(req.params);
    const body = patchUserBody.parse(req.body);
    const [target] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!target) throw errors.notFound("Пользователь не найден.");
    if (body.isActive === false && (target.id === actor.userId || target.role === "owner")) {
      throw errors.invalid("Нельзя отключить владельца.");
    }
    if ((body.subscribedUntil !== undefined || body.subscriptionDays !== undefined) && target.role !== "public") {
      throw errors.invalid("Подписка нужна только публичным пользователям.");
    }
    if (body.password !== undefined && target.email === null) {
      throw errors.invalid("У гостя нет пароля.");
    }

    const changes: Partial<typeof users.$inferInsert> = {};
    if (body.monthlyBudgetUsd !== undefined) changes.monthlyBudgetUsd = usd(body.monthlyBudgetUsd);
    if (body.windowLimitUsd !== undefined) changes.windowLimitUsd = usd(body.windowLimitUsd);
    if (body.isActive !== undefined) changes.isActive = body.isActive;
    if (Object.keys(changes).length) await db.update(users).set(changes).where(eq(users.id, id));
    if (body.subscribedUntil !== undefined) await auth.setSubscription(id, body.subscribedUntil === null ? null : new Date(body.subscribedUntil));
    if (body.subscriptionDays !== undefined) await auth.extendSubscription(id, body.subscriptionDays);
    if (body.password !== undefined) await auth.setPassword(id, body.password);
    // Отключённого пользователя сразу выкидываем из всех открытых входов.
    if (body.isActive === false) await auth.revokeUserSessions(id);

    const [updated] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return { user: view(updated!) };
  });

  scope.get("/admin/usage", async (req) => {
    await ownerOf(req);
    const { month } = monthQuery.parse(req.query);
    const bounds = month ? parseMonthKey(month)! : monthBounds(new Date());
    const report = await usageReport(db, bounds);
    return { month: bounds.key, users: report.rows, totalUsd: report.totalUsd, totalFreeUsd: report.totalFreeUsd };
  });
}
