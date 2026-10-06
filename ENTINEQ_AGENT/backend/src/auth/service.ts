import { and, eq, gt, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { utcDay } from "../access.js";
import type { Db } from "../db/index.js";
import { authSessions, conversations, users } from "../db/schema.js";
import { AppError, errors, isUniqueViolation } from "../errors.js";
import { ENTRY_ROLES, type Actor, type Entry, type PublicUser } from "../types.js";
import { humanDuration } from "../usage/format.js";
import type { PasswordHasher } from "./password.js";
import { hashToken, newSessionToken } from "./tokens.js";

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
const toPublic = (user: UserRow): PublicUser => ({ id: user.id, email: user.email, role: user.role, guest: user.email === null });
const usd = (value: number | null) => (value === null ? null : value.toFixed(6));

const invalidCredentials = () => new AppError("invalid_credentials", "Неверный email или пароль.", 401);
const emailTaken = () => errors.conflict("email_taken", "Этот email уже зарегистрирован.");

export interface SessionGrant {
  token: string;
  expiresAt: Date;
}

export interface Limits {
  monthlyBudgetUsd: number | null;
  windowLimitUsd: number | null;
}

/** Настройки, от которых зависит заведение аккаунтов. */
export interface AuthPolicy {
  /** Сколько новых аккаунтов (гостевых и настоящих) в сутки (UTC) можно завести с одного адреса. */
  signupIpDailyCap: number;
  /** Лимиты, которые получает подписчик, пока владелец не изменил их вручную. */
  publicDefaults: Limits;
}

const DEFAULT_POLICY: AuthPolicy = { signupIpDailyCap: 30, publicDefaults: { monthlyBudgetUsd: 10, windowLimitUsd: 1 } };

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly sessionTtlDays: number,
    private readonly hasher: PasswordHasher,
    private readonly now: () => Date = () => new Date(),
    private readonly policy: AuthPolicy = DEFAULT_POLICY,
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

  /** Новых аккаунтов с этого адреса сегодня уже слишком много - отказ (защита от потока пустых гостей и регистраций). */
  private async assertSignupAllowed(ipHash: string): Promise<void> {
    const now = this.now();
    const day = utcDay(now);
    const [row] = await this.db
      .select({ total: sql<string>`count(*)` })
      .from(users)
      .where(and(eq(users.signupIpHash, ipHash), gte(users.createdAt, day.start)));
    if (Number(row?.total ?? 0) >= this.policy.signupIpDailyCap) {
      throw new AppError(
        "signup_limit",
        `Слишком много новых аккаунтов с вашего адреса. Попробуйте через ${humanDuration(day.end.getTime() - now.getTime())}.`,
        429,
        day.end.toISOString(),
      );
    }
  }

  /** Гость: аккаунт без email и пароля, нужен, чтобы вести бесплатные запросы и историю до регистрации. */
  async createGuest(input: { ipHash: string }) {
    await this.assertSignupAllowed(input.ipHash);
    const [user] = await this.db
      .insert(users)
      .values({
        role: "public",
        monthlyBudgetUsd: usd(this.policy.publicDefaults.monthlyBudgetUsd),
        windowLimitUsd: usd(this.policy.publicDefaults.windowLimitUsd),
        signupIpHash: input.ipHash,
        createdAt: this.now(),
      })
      .returning();
    return { user: toPublic(user!), ...(await this.createSession(user!.id, "internal")) };
  }

  /**
   * Регистрация. Если у посетителя уже есть гостевая сессия, гость становится настоящим аккаунтом: история диалогов и
   * счётчик бесплатных запросов сохраняются. Сессия при этом заменяется новой (старый токен перестаёт действовать).
   * Без гостевой сессии создаётся новый аккаунт.
   */
  async register(input: { email: string; password: string; guestToken?: string; ipHash: string }) {
    assertPasswordAcceptable(input.password);
    const passwordHash = await this.hasher.hash(input.password);
    const email = normalizeEmail(input.email);

    const guest = input.guestToken ? await this.authenticate(input.guestToken, "internal") : null;
    let user: UserRow | undefined;
    try {
      if (guest?.guest) {
        // Условие email is null защищает от двух одновременных регистраций одного гостя: выиграет одна.
        [user] = await this.db
          .update(users)
          .set({ email, passwordHash })
          .where(and(eq(users.id, guest.userId), isNull(users.email)))
          .returning();
      }
      if (!user) {
        await this.assertSignupAllowed(input.ipHash);
        [user] = await this.db
          .insert(users)
          .values({
            email,
            passwordHash,
            role: "public",
            monthlyBudgetUsd: usd(this.policy.publicDefaults.monthlyBudgetUsd),
            windowLimitUsd: usd(this.policy.publicDefaults.windowLimitUsd),
            signupIpHash: input.ipHash,
            createdAt: this.now(),
          })
          .returning();
      }
    } catch (error) {
      if (isUniqueViolation(error)) throw emailTaken();
      throw error;
    }
    // Вход заменяет гостевую сессию: после повышения прав старый токен действовать не должен.
    await this.revokeUserSessions(user!.id);
    return { user: toPublic(user!), ...(await this.createSession(user!.id, "internal")) };
  }

  async login(input: { email: string; password: string; entry: Entry }) {
    const email = normalizeEmail(input.email);
    const [user] = await this.db.select().from(users).where(eq(users.email, email)).limit(1);
    const now = this.now();

    if (!user || !user.passwordHash) {
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
    return { userId: row.user.id, email: row.user.email, role: row.user.role, entry, guest: row.user.email === null };
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
      .where(and(eq(users.id, userId), sql`${users.email} is not null`))
      .returning({ id: users.id });
    if (!rows.length) throw errors.notFound("Пользователь не найден.");
    await this.revokeUserSessions(userId);
  }

  /** Подписка: до какого момента действует (null - снять). Только для публичных аккаунтов. */
  async setSubscription(userId: string, until: Date | null): Promise<Date | null> {
    const rows = await this.db
      .update(users)
      .set({ subscribedUntil: until })
      .where(and(eq(users.id, userId), eq(users.role, "public")))
      .returning({ subscribedUntil: users.subscribedUntil });
    if (!rows.length) throw errors.notFound("Публичный пользователь не найден.");
    return rows[0]!.subscribedUntil;
  }

  /** Продлевает подписку на N суток: от текущего конца, а если она закончилась или её не было - от сегодня. */
  async extendSubscription(userId: string, days: number): Promise<Date> {
    const now = this.now();
    const [user] = await this.db
      .select({ subscribedUntil: users.subscribedUntil })
      .from(users)
      .where(and(eq(users.id, userId), eq(users.role, "public")))
      .limit(1);
    if (!user) throw errors.notFound("Публичный пользователь не найден.");
    const base = user.subscribedUntil && user.subscribedUntil > now ? user.subscribedUntil : now;
    const until = new Date(base.getTime() + days * 86_400_000);
    await this.setSubscription(userId, until);
    return until;
  }

  async purgeExpired(): Promise<void> {
    await this.db.delete(authSessions).where(sql`${authSessions.expiresAt} <= ${this.now().toISOString()}::timestamptz`);
  }

  /**
   * Уборка гостей: диалоги гостей без активности дольше срока удаляются, а сами гостевые аккаунты - если по ним нет ни диалогов,
   * ни записей учёта расходов (учёт трогать нельзя). Настоящие пользователи не затрагиваются.
   */
  async purgeGuests(retentionDays: number): Promise<{ conversations: number; guests: number }> {
    const cutoff = new Date(this.now().getTime() - retentionDays * 86_400_000);
    const guestIds = this.db.select({ id: users.id }).from(users).where(isNull(users.email));
    const removedConversations = await this.db
      .delete(conversations)
      .where(and(inArray(conversations.userId, guestIds), lt(conversations.updatedAt, cutoff)))
      .returning({ id: conversations.id });
    const removedGuests = await this.db
      .delete(users)
      .where(
        and(
          isNull(users.email),
          lt(users.createdAt, cutoff),
          sql`not exists (select 1 from conversations c where c.user_id = ${users.id})`,
          sql`not exists (select 1 from usage_events e where e.user_id = ${users.id})`,
        ),
      )
      .returning({ id: users.id });
    return { conversations: removedConversations.length, guests: removedGuests.length };
  }
}
