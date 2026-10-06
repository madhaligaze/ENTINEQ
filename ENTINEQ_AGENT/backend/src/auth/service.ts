import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { authSessions, invites, users } from "../db/schema.js";
import { AppError, errors, isUniqueViolation } from "../errors.js";
import { ENTRY_ROLES, type Actor, type Entry, type PublicUser } from "../types.js";
import type { PasswordHasher } from "./password.js";
import { hashInviteCode, hashToken, newInviteCode, newSessionToken } from "./tokens.js";

const MAX_FAILED_LOGINS = 8;
const LOCK_MINUTES = 10;
/** Время последнего использования обновляем не чаще, чем раз в это время (чтобы не писать в БД на каждый запрос). */
const TOUCH_INTERVAL_MS = 5 * 60_000;

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export function assertPasswordAcceptable(password: string): void {
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw errors.invalid(`Пароль: от ${PASSWORD_MIN} до ${PASSWORD_MAX} символов.`);
  }
}

type UserRow = typeof users.$inferSelect;
const toPublic = (user: UserRow): PublicUser => ({ id: user.id, email: user.email, role: user.role });
const usd = (value: number | null) => (value === null ? null : value.toFixed(6));

const invalidCredentials = () => new AppError("invalid_credentials", "Неверный email или пароль.", 401);
const emailTaken = () => errors.conflict("email_taken", "Этот email уже зарегистрирован.");
const invalidInvite = () => new AppError("invalid_invite", "Приглашение недействительно или уже использовано.", 400);

export interface SessionGrant {
  token: string;
  expiresAt: Date;
}

export interface Limits {
  monthlyBudgetUsd: number | null;
  windowLimitUsd: number | null;
}

export interface InviteView {
  id: string;
  codeHint: string;
  monthlyBudgetUsd: number | null;
  windowLimitUsd: number | null;
  expiresAt: Date;
  createdAt: Date;
  usedAt: Date | null;
  usedByEmail: string | null;
  status: "active" | "used" | "revoked" | "expired";
}

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly sessionTtlDays: number,
    private readonly hasher: PasswordHasher,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Создаёт владельца при первом запуске. Если владелец уже есть - ничего не меняет. */
  async bootstrapOwner(email: string, password: string): Promise<boolean> {
    assertPasswordAcceptable(password);
    const [existing] = await this.db.select({ id: users.id }).from(users).where(eq(users.role, "owner")).limit(1);
    if (existing) return false;
    const passwordHash = await this.hasher.hash(password);
    try {
      await this.db.insert(users).values({ email: normalizeEmail(email), passwordHash, role: "owner" });
    } catch (error) {
      if (isUniqueViolation(error)) throw new Error(`Пользователь ${email} уже есть и не является владельцем.`);
      throw error;
    }
    return true;
  }

  /** Администратор создаёт аккаунт напрямую (доверенный или публичный). */
  async createUser(input: { email: string; password: string; role: "trusted" | "public" } & Limits): Promise<PublicUser> {
    assertPasswordAcceptable(input.password);
    const passwordHash = await this.hasher.hash(input.password);
    try {
      const [user] = await this.db
        .insert(users)
        .values({
          email: normalizeEmail(input.email),
          passwordHash,
          role: input.role,
          monthlyBudgetUsd: usd(input.monthlyBudgetUsd),
          windowLimitUsd: usd(input.windowLimitUsd),
        })
        .returning();
      return toPublic(user!);
    } catch (error) {
      if (isUniqueViolation(error)) throw emailTaken();
      throw error;
    }
  }

  async createInvites(input: { count: number; expiresInDays: number; createdBy: string } & Limits) {
    const expiresAt = new Date(this.now().getTime() + input.expiresInDays * 86_400_000);
    const created: { id: string; code: string; expiresAt: Date }[] = [];
    for (let i = 0; i < input.count; i++) {
      const code = newInviteCode();
      const [row] = await this.db
        .insert(invites)
        .values({
          codeHash: hashInviteCode(code),
          codeHint: code.slice(-4),
          monthlyBudgetUsd: usd(input.monthlyBudgetUsd),
          windowLimitUsd: usd(input.windowLimitUsd),
          expiresAt,
          createdBy: input.createdBy,
        })
        .returning({ id: invites.id });
      created.push({ id: row!.id, code, expiresAt });
    }
    return created;
  }

  async listInvites(): Promise<InviteView[]> {
    const rows = await this.db
      .select({ invite: invites, usedByEmail: users.email })
      .from(invites)
      .leftJoin(users, eq(invites.usedBy, users.id))
      .orderBy(desc(invites.createdAt))
      .limit(200);
    const now = this.now();
    return rows.map(({ invite, usedByEmail }) => ({
      id: invite.id,
      codeHint: invite.codeHint,
      monthlyBudgetUsd: invite.monthlyBudgetUsd === null ? null : Number(invite.monthlyBudgetUsd),
      windowLimitUsd: invite.windowLimitUsd === null ? null : Number(invite.windowLimitUsd),
      expiresAt: invite.expiresAt,
      createdAt: invite.createdAt,
      usedAt: invite.usedAt,
      usedByEmail,
      status: invite.usedAt ? "used" : invite.revokedAt ? "revoked" : invite.expiresAt <= now ? "expired" : "active",
    }));
  }

  async revokeInvite(id: string): Promise<boolean> {
    const rows = await this.db
      .update(invites)
      .set({ revokedAt: this.now() })
      .where(and(eq(invites.id, id), isNull(invites.usedAt), isNull(invites.revokedAt)))
      .returning({ id: invites.id });
    return rows.length > 0;
  }

  /** Регистрация публичного пользователя по приглашению. Приглашение гасится в той же транзакции, что и создание аккаунта. */
  async register(input: { email: string; password: string; inviteCode: string }) {
    assertPasswordAcceptable(input.password);
    const passwordHash = await this.hasher.hash(input.password);
    const codeHash = hashInviteCode(input.inviteCode);
    const now = this.now();
    let user: UserRow;
    try {
      user = await this.db.transaction(async (tx) => {
        const [invite] = await tx.select().from(invites).where(eq(invites.codeHash, codeHash)).for("update");
        if (!invite || invite.usedAt || invite.revokedAt || invite.expiresAt <= now) throw invalidInvite();
        const [created] = await tx
          .insert(users)
          .values({
            email: normalizeEmail(input.email),
            passwordHash,
            role: "public",
            monthlyBudgetUsd: invite.monthlyBudgetUsd,
            windowLimitUsd: invite.windowLimitUsd,
          })
          .returning();
        await tx.update(invites).set({ usedBy: created!.id, usedAt: now }).where(eq(invites.id, invite.id));
        return created!;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw emailTaken();
      throw error;
    }
    return { user: toPublic(user), ...(await this.createSession(user.id, "internal")) };
  }

  async login(input: { email: string; password: string; entry: Entry }) {
    const email = normalizeEmail(input.email);
    const [user] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    const now = this.now();

    if (!user) {
      // Тратим столько же времени, сколько на реальную проверку: по скорости ответа нельзя узнать, есть ли аккаунт.
      await this.hasher.verify(input.password, await this.hasher.dummy);
      throw invalidCredentials();
    }
    if (user.lockedUntil && user.lockedUntil > now) {
      throw new AppError("account_locked", "Слишком много неудачных попыток входа. Попробуйте через 10 минут.", 423);
    }

    const passwordOk = await this.hasher.verify(input.password, user.passwordHash);
    if (!passwordOk) {
      const lockUntil = new Date(now.getTime() + LOCK_MINUTES * 60_000);
      await this.db
        .update(users)
        .set({
          failedLogins: sql`${users.failedLogins} + 1`,
          lockedUntil: sql`case when ${users.failedLogins} + 1 >= ${MAX_FAILED_LOGINS} then ${lockUntil.toISOString()}::timestamptz else ${users.lockedUntil} end`,
        })
        .where(eq(users.id, user.id));
      throw invalidCredentials();
    }

    // Аккаунт чужой «двери» не раскрываем: для владельца/доверенного через публичный вход ответ такой же, как при неверном пароле.
    if (!ENTRY_ROLES[input.entry].includes(user.role)) throw invalidCredentials();
    if (!user.isActive) throw new AppError("account_disabled", "Аккаунт отключён. Обратитесь к администратору.", 403);

    if (user.failedLogins > 0 || user.lockedUntil) {
      await this.db.update(users).set({ failedLogins: 0, lockedUntil: null }).where(eq(users.id, user.id));
    }
    return { user: toPublic(user), ...(await this.createSession(user.id, input.entry)) };
  }

  private async createSession(userId: string, entry: Entry): Promise<SessionGrant> {
    const token = newSessionToken();
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.sessionTtlDays * 86_400_000);
    await this.db.insert(authSessions).values({ userId, tokenHash: hashToken(token), entry, createdAt: now, lastUsedAt: now, expiresAt });
    return { token, expiresAt };
  }

  /** По токену возвращает того, кто за ним стоит, либо null. Роль обязана подходить к «двери». */
  async authenticate(token: string | undefined, entry: Entry): Promise<Actor | null> {
    if (!token || token.length > 200) return null;
    const now = this.now();
    const [row] = await this.db
      .select({ session: authSessions, user: users })
      .from(authSessions)
      .innerJoin(users, eq(authSessions.userId, users.id))
      .where(and(eq(authSessions.tokenHash, hashToken(token)), gt(authSessions.expiresAt, now), eq(users.isActive, true)))
      .limit(1);
    if (!row || row.session.entry !== entry || !ENTRY_ROLES[entry].includes(row.user.role)) return null;
    if (now.getTime() - row.session.lastUsedAt.getTime() > TOUCH_INTERVAL_MS) {
      await this.db.update(authSessions).set({ lastUsedAt: now }).where(eq(authSessions.id, row.session.id));
    }
    return { userId: row.user.id, email: row.user.email, role: row.user.role, entry };
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    await this.db.delete(authSessions).where(eq(authSessions.tokenHash, hashToken(token)));
  }

  async revokeUserSessions(userId: string): Promise<void> {
    await this.db.delete(authSessions).where(eq(authSessions.userId, userId));
  }

  /** Смена пароля администратором: старые входы перестают действовать, блокировка снимается. */
  async setPassword(userId: string, password: string): Promise<void> {
    assertPasswordAcceptable(password);
    const passwordHash = await this.hasher.hash(password);
    const rows = await this.db
      .update(users)
      .set({ passwordHash, failedLogins: 0, lockedUntil: null })
      .where(eq(users.id, userId))
      .returning({ id: users.id });
    if (!rows.length) throw errors.notFound("Пользователь не найден.");
    await this.revokeUserSessions(userId);
  }

  async purgeExpired(): Promise<void> {
    await this.db.delete(authSessions).where(sql`${authSessions.expiresAt} <= ${this.now().toISOString()}::timestamptz`);
  }
}
