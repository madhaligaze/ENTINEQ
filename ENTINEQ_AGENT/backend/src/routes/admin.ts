import { asc, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { users } from "../db/schema.js";
import { errors } from "../errors.js";
import { createInvitesBody, createUserBody, idParam, monthQuery, patchUserBody } from "../schemas.js";
import type { Actor } from "../types.js";
import { monthBounds, parseMonthKey, usageReport } from "../usage/ledger.js";
import type { AppContext } from "./context.js";

const usd = (value: number | null) => (value === null ? null : value.toFixed(6));
const num = (value: string | null) => (value === null ? null : Number(value));

/** Администрирование: только для владельца. */
export function registerAdmin(scope: FastifyInstance, ctx: AppContext, ownerOf: (req: FastifyRequest) => Promise<Actor>): void {
  const { db, auth, cfg } = ctx;

  scope.get("/admin/users", async (req) => {
    await ownerOf(req);
    const rows = await db.select().from(users).orderBy(asc(users.createdAt));
    const { rows: report } = await usageReport(db, monthBounds(new Date()));
    const spent = new Map(report.map((row) => [row.userId, row.costUsd]));
    return {
      users: rows.map((row) => ({
        id: row.id,
        email: row.email,
        role: row.role,
        isActive: row.isActive,
        monthlyBudgetUsd: num(row.monthlyBudgetUsd),
        windowLimitUsd: num(row.windowLimitUsd),
        spentThisMonthUsd: spent.get(row.id) ?? 0,
        createdAt: row.createdAt.toISOString(),
      })),
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

    const changes: Partial<typeof users.$inferInsert> = {};
    if (body.monthlyBudgetUsd !== undefined) changes.monthlyBudgetUsd = usd(body.monthlyBudgetUsd);
    if (body.windowLimitUsd !== undefined) changes.windowLimitUsd = usd(body.windowLimitUsd);
    if (body.isActive !== undefined) changes.isActive = body.isActive;
    if (Object.keys(changes).length) await db.update(users).set(changes).where(eq(users.id, id));
    if (body.password !== undefined) await auth.setPassword(id, body.password);
    // Отключённого пользователя сразу выкидываем из всех открытых входов.
    if (body.isActive === false) await auth.revokeUserSessions(id);

    const [updated] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return {
      user: {
        id: updated!.id,
        email: updated!.email,
        role: updated!.role,
        isActive: updated!.isActive,
        monthlyBudgetUsd: num(updated!.monthlyBudgetUsd),
        windowLimitUsd: num(updated!.windowLimitUsd),
      },
    };
  });

  scope.get("/admin/invites", async (req) => {
    await ownerOf(req);
    const rows = await auth.listInvites();
    return {
      invites: rows.map((row) => ({
        ...row,
        expiresAt: row.expiresAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        usedAt: row.usedAt?.toISOString() ?? null,
      })),
    };
  });

  scope.post("/admin/invites", async (req, reply) => {
    const actor = await ownerOf(req);
    const body = createInvitesBody.parse(req.body ?? {});
    const defaults = cfg.defaults.public;
    const created = await auth.createInvites({
      count: body.count,
      expiresInDays: body.expiresInDays,
      createdBy: actor.userId,
      monthlyBudgetUsd: body.monthlyBudgetUsd === undefined ? defaults.monthlyBudgetUsd : body.monthlyBudgetUsd,
      windowLimitUsd: body.windowLimitUsd === undefined ? defaults.windowLimitUsd : body.windowLimitUsd,
    });
    // Коды показываются только сейчас: в БД хранится лишь их хеш.
    return reply.code(201).send({ invites: created.map((invite) => ({ ...invite, expiresAt: invite.expiresAt.toISOString() })) });
  });

  scope.delete("/admin/invites/:id", async (req, reply) => {
    await ownerOf(req);
    const { id } = idParam.parse(req.params);
    if (!(await auth.revokeInvite(id))) throw errors.notFound("Приглашение не найдено или уже использовано.");
    return reply.code(204).send();
  });

  scope.get("/admin/usage", async (req) => {
    await ownerOf(req);
    const { month } = monthQuery.parse(req.query);
    const bounds = month ? parseMonthKey(month)! : monthBounds(new Date());
    const report = await usageReport(db, bounds);
    return { month: bounds.key, users: report.rows, totalUsd: report.totalUsd };
  });
}
