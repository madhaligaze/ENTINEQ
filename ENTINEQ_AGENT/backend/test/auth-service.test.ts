import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authSessions, invites, users } from "../src/db/schema.js";
import { AppError } from "../src/errors.js";
import { createHarness, OWNER, uniqueEmail, type Harness } from "./helpers.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return "ok";
  } catch (error) {
    return error instanceof AppError ? error.code : `не AppError: ${String(error)}`;
  }
};

const newInvite = async (options: { days?: number; monthly?: number | null; window?: number | null } = {}) => {
  const [invite] = await h.auth.createInvites({
    count: 1,
    expiresInDays: options.days ?? 14,
    createdBy: (await h.db.select().from(users).where(eq(users.role, "owner")))[0]!.id,
    monthlyBudgetUsd: options.monthly === undefined ? 10 : options.monthly,
    windowLimitUsd: options.window === undefined ? 1 : options.window,
  });
  return invite!.code;
};

describe("владелец", () => {
  it("bootstrapOwner создаёт владельца один раз и не перезаписывает пароль", async () => {
    expect(await h.auth.bootstrapOwner("someone@example.com", "another-password-1")).toBe(false);
    const session = await h.auth.login({ email: OWNER.email, password: OWNER.password, entry: "direct" });
    expect(session.user.role).toBe("owner");
  });

  it("слабый пароль владельца отвергается", async () => {
    await expect(h.auth.bootstrapOwner("x@example.com", "short")).rejects.toBeInstanceOf(AppError);
  });
});

describe("createUser", () => {
  it("создаёт пользователя; email нормализуется и уникален без учёта регистра", async () => {
    const email = uniqueEmail("cu");
    const user = await h.auth.createUser({ email: `  ${email.toUpperCase()} `, password: "password-12345", role: "trusted", monthlyBudgetUsd: null, windowLimitUsd: 5 });
    expect(user.email).toBe(email);
    expect(await code(h.auth.createUser({ email, password: "password-12345", role: "public", monthlyBudgetUsd: 1, windowLimitUsd: 1 }))).toBe("email_taken");
  });
});

describe("регистрация по приглашению", () => {
  it("создаёт публичного пользователя с лимитами из приглашения", async () => {
    const invite = await newInvite({ monthly: 7.5, window: 0.75 });
    const email = uniqueEmail("reg");
    const result = await h.auth.register({ email, password: "password-12345", inviteCode: invite });
    expect(result.user).toMatchObject({ email, role: "public" });
    const [row] = await h.db.select().from(users).where(eq(users.id, result.user.id));
    expect(Number(row!.monthlyBudgetUsd)).toBe(7.5);
    expect(Number(row!.windowLimitUsd)).toBe(0.75);
    expect(result.token.length).toBeGreaterThan(40);
  });

  it("приглашение одноразовое; регистр и дефисы в коде не важны", async () => {
    const invite = await newInvite();
    const messy = invite.toLowerCase().replaceAll("-", " ");
    await h.auth.register({ email: uniqueEmail(), password: "password-12345", inviteCode: messy });
    expect(await code(h.auth.register({ email: uniqueEmail(), password: "password-12345", inviteCode: invite }))).toBe("invalid_invite");
  });

  it("два одновременных использования одного кода: пройдёт ровно одно", async () => {
    const invite = await newInvite();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => code(h.auth.register({ email: uniqueEmail(), password: "password-12345", inviteCode: invite }))),
    );
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(results.filter((r) => r === "invalid_invite")).toHaveLength(3);
  });

  it("несуществующий, просроченный и отозванный коды отвергаются одинаково", async () => {
    expect(await code(h.auth.register({ email: uniqueEmail(), password: "password-12345", inviteCode: "ENT-0000-0000-0000" }))).toBe("invalid_invite");

    const expired = await newInvite({ days: 1 });
    h.clock.now = new Date(h.clock.now.getTime() + 2 * 86_400_000);
    expect(await code(h.auth.register({ email: uniqueEmail(), password: "password-12345", inviteCode: expired }))).toBe("invalid_invite");
    h.clock.now = new Date(h.clock.now.getTime() - 2 * 86_400_000);

    const revoked = await newInvite();
    const [row] = await h.db.select().from(invites).where(eq(invites.codeHint, revoked.slice(-4)));
    expect(await h.auth.revokeInvite(row!.id)).toBe(true);
    expect(await h.auth.revokeInvite(row!.id)).toBe(false);
    expect(await code(h.auth.register({ email: uniqueEmail(), password: "password-12345", inviteCode: revoked }))).toBe("invalid_invite");
  });

  it("занятый email не сжигает приглашение", async () => {
    const taken = uniqueEmail("taken");
    await h.auth.register({ email: taken, password: "password-12345", inviteCode: await newInvite() });
    const invite = await newInvite();
    expect(await code(h.auth.register({ email: taken, password: "password-12345", inviteCode: invite }))).toBe("email_taken");
    // Тот же код остаётся рабочим для другого адреса.
    expect(await code(h.auth.register({ email: uniqueEmail(), password: "password-12345", inviteCode: invite }))).toBe("ok");
  });

  it("список приглашений показывает статусы и не раскрывает коды", async () => {
    const list = await h.auth.listInvites();
    expect(new Set(list.map((i) => i.status))).toEqual(new Set(["active", "used", "revoked", "expired"].filter((s) => list.some((i) => i.status === s))));
    expect(list.some((i) => i.status === "used" && i.usedByEmail)).toBe(true);
    expect(JSON.stringify(list)).not.toMatch(/ENT-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}/);
  });
});

describe("вход", () => {
  const make = async (role: "trusted" | "public" = "trusted") => {
    const email = uniqueEmail("login");
    const user = await h.auth.createUser({ email, password: "password-12345", role, monthlyBudgetUsd: null, windowLimitUsd: null });
    return { email, user };
  };

  it("верный пароль - сессия; неверный и неизвестный email дают одинаковую ошибку", async () => {
    const { email } = await make();
    const ok = await h.auth.login({ email: email.toUpperCase(), password: "password-12345", entry: "direct" });
    expect(ok.token).toBeTruthy();
    const rejection = async (promise: Promise<unknown>): Promise<AppError> => {
      try {
        await promise;
      } catch (error) {
        return error as AppError;
      }
      throw new Error("ожидалась ошибка входа");
    };
    const wrong = await rejection(h.auth.login({ email, password: "wrong-password", entry: "direct" }));
    const unknown = await rejection(h.auth.login({ email: uniqueEmail(), password: "wrong-password", entry: "direct" }));
    expect([wrong.code, unknown.code]).toEqual(["invalid_credentials", "invalid_credentials"]);
    expect(wrong.message).toBe(unknown.message);
  });

  it("через чужую «дверь» войти нельзя, ответ такой же, как при неверном пароле", async () => {
    const trusted = await make("trusted");
    const pub = await make("public");
    expect(await code(h.auth.login({ email: trusted.email, password: "password-12345", entry: "internal" }))).toBe("invalid_credentials");
    expect(await code(h.auth.login({ email: pub.email, password: "password-12345", entry: "direct" }))).toBe("invalid_credentials");
    expect(await code(h.auth.login({ email: OWNER.email, password: OWNER.password, entry: "internal" }))).toBe("invalid_credentials");
  });

  it("после 8 неудач аккаунт блокируется даже для верного пароля, затем блокировка истекает", async () => {
    const { email, user } = await make();
    for (let i = 0; i < 8; i++) {
      expect(await code(h.auth.login({ email, password: `wrong-${i}`, entry: "direct" }))).toBe("invalid_credentials");
    }
    expect(await code(h.auth.login({ email, password: "password-12345", entry: "direct" }))).toBe("account_locked");
    await h.db.update(users).set({ lockedUntil: new Date(h.clock.now.getTime() - 1000) }).where(eq(users.id, user.id));
    expect(await code(h.auth.login({ email, password: "password-12345", entry: "direct" }))).toBe("ok");
    const [row] = await h.db.select().from(users).where(eq(users.id, user.id));
    expect(row).toMatchObject({ failedLogins: 0, lockedUntil: null });
  });

  it("успешный вход сбрасывает счётчик неудач", async () => {
    const { email } = await make();
    for (let i = 0; i < 5; i++) await code(h.auth.login({ email, password: "nope-nope-nope", entry: "direct" }));
    await h.auth.login({ email, password: "password-12345", entry: "direct" });
    for (let i = 0; i < 5; i++) await code(h.auth.login({ email, password: "nope-nope-nope", entry: "direct" }));
    expect(await code(h.auth.login({ email, password: "password-12345", entry: "direct" }))).toBe("ok");
  });

  it("отключённый аккаунт не входит", async () => {
    const { email, user } = await make();
    await h.db.update(users).set({ isActive: false }).where(eq(users.id, user.id));
    expect(await code(h.auth.login({ email, password: "password-12345", entry: "direct" }))).toBe("account_disabled");
  });
});

describe("authenticate", () => {
  const session = async (role: "trusted" | "public" = "trusted") => {
    const email = uniqueEmail("auth");
    const user = await h.auth.createUser({ email, password: "password-12345", role, monthlyBudgetUsd: null, windowLimitUsd: null });
    const entry = role === "public" ? "internal" : "direct";
    const grant = await h.auth.login({ email, password: "password-12345", entry });
    return { user, token: grant.token, entry } as const;
  };

  it("по токену возвращает личность; мусор и пустое значение - null", async () => {
    const { token, user, entry } = await session();
    expect(await h.auth.authenticate(token, entry)).toMatchObject({ userId: user.id, role: "trusted", entry: "direct" });
    for (const bad of [undefined, "", "мусор", "x".repeat(500)]) expect(await h.auth.authenticate(bad, "direct")).toBeNull();
  });

  it("токен привязан к своей «двери»", async () => {
    const trusted = await session("trusted");
    const pub = await session("public");
    expect(await h.auth.authenticate(trusted.token, "internal")).toBeNull();
    expect(await h.auth.authenticate(pub.token, "direct")).toBeNull();
  });

  it("токен перестаёт действовать после выхода, отключения пользователя и срока", async () => {
    const a = await session();
    await h.auth.logout(a.token);
    expect(await h.auth.authenticate(a.token, "direct")).toBeNull();

    const b = await session();
    await h.db.update(users).set({ isActive: false }).where(eq(users.id, b.user.id));
    expect(await h.auth.authenticate(b.token, "direct")).toBeNull();

    const c = await session();
    h.clock.now = new Date(h.clock.now.getTime() + 31 * 86_400_000);
    expect(await h.auth.authenticate(c.token, "direct")).toBeNull();
    h.clock.now = new Date(h.clock.now.getTime() - 31 * 86_400_000);
  });

  it("смена пароля администратором закрывает все старые входы и снимает блокировку", async () => {
    const { token, user } = await session();
    await h.auth.setPassword(user.id, "brand-new-password-1");
    expect(await h.auth.authenticate(token, "direct")).toBeNull();
    const again = await h.auth.login({ email: user.email, password: "brand-new-password-1", entry: "direct" });
    expect(again.token).toBeTruthy();
    expect(await code(h.auth.setPassword("00000000-0000-4000-8000-000000000000", "brand-new-password-1"))).toBe("not_found");
  });

  it("purgeExpired удаляет только просроченные сессии", async () => {
    const live = await session();
    const old = await session();
    h.clock.now = new Date(h.clock.now.getTime() + 31 * 86_400_000);
    const liveAfter = await h.auth.login({ email: live.user.email, password: "password-12345", entry: "direct" });
    await h.auth.purgeExpired();
    h.clock.now = new Date(h.clock.now.getTime() - 31 * 86_400_000);
    const rows = await h.db.select().from(authSessions);
    expect(rows.some((r) => r.userId === old.user.id)).toBe(false);
    expect(liveAfter.token).toBeTruthy();
  });
});
