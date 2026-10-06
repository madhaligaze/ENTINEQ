import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type DbHandle } from "../src/db/index.js";
import { conversations, users } from "../src/db/schema.js";
import {
  blockReason,
  classifyUsage,
  diffUsage,
  getLimitStatus,
  humanDuration,
  isZeroSnapshot,
  monthBounds,
  normalizeModelUsage,
  openWindow,
  parseMonthKey,
  recordTurnUsage,
  turnBudgetUsd,
  usageDto,
  usageReport,
  type LimitStatus,
  type Snapshot,
} from "../src/usage/ledger.js";

const totals = (costUSD: number, inputTokens = 100, outputTokens = 50) => ({
  inputTokens,
  outputTokens,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUSD,
});

describe("normalizeModelUsage", () => {
  it("берёт нужные поля и отбрасывает мусор", () => {
    expect(
      normalizeModelUsage({
        "claude-x": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 3, cacheCreationInputTokens: 2, costUSD: 0.5, contextWindow: 9 },
        bad: null,
        worse: "строка",
        negative: { inputTokens: -5, outputTokens: Number.NaN, costUSD: "1" },
      }),
    ).toEqual({
      "claude-x": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 3, cacheCreationInputTokens: 2, costUSD: 0.5 },
      negative: totalsZero(),
    });
    expect(normalizeModelUsage(undefined)).toEqual({});
    expect(normalizeModelUsage("x")).toEqual({});
  });

  it("isZeroSnapshot узнаёт нулевой результат аварийного завершения", () => {
    expect(isZeroSnapshot({})).toBe(true);
    expect(isZeroSnapshot({ m: totalsZero() })).toBe(true);
    expect(isZeroSnapshot({ m: totals(0.01) })).toBe(false);
  });
});

function totalsZero() {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0 };
}

describe("diffUsage (расход за ход из накопительных итогов SDK)", () => {
  it("первый ход: расход равен итогам", () => {
    expect(diffUsage({}, { m: totals(0.5) })).toEqual([{ model: "m", ...totals(0.5) }]);
  });

  it("продолжение сессии: берётся только разница - прошлые ходы не считаются второй раз", () => {
    const delta = diffUsage({ m: totals(0.5, 100, 50) }, { m: totals(0.8, 250, 90) });
    expect(delta).toEqual([{ model: "m", inputTokens: 150, outputTokens: 40, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.3 }]);
  });

  it("счётчик уменьшился (SDK начал отсчёт заново): итоги берутся целиком", () => {
    expect(diffUsage({ m: totals(5, 1000, 500) }, { m: totals(0.2, 10, 5) })).toEqual([{ model: "m", ...totals(0.2, 10, 5) }]);
  });

  it("новая модель в итогах считается целиком, старая без изменений - пропускается", () => {
    const result = diffUsage({ a: totals(1) }, { a: totals(1), b: totals(0.25) });
    expect(result.map((d) => d.model)).toEqual(["b"]);
  });

  it("нулевой прирост не создаёт записей", () => {
    expect(diffUsage({ m: totals(1) }, { m: totals(1) })).toEqual([]);
  });

  it("не оставляет хвостов плавающей запятой", () => {
    const [delta] = diffUsage({ m: totals(0.1) }, { m: totals(0.3) });
    expect(delta!.costUSD).toBe(0.2);
  });
});

describe("classifyUsage - накопительные ли итоги SDK", () => {
  const prev = { m: totals(1, 1000, 500) }; // всего 1500 токенов
  it("первый ход: сравнивать не с чем", () => {
    expect(classifyUsage({}, { m: totals(0.5) }, 150)).toBe("first");
  });

  it("накопительные: прирост токенов не меньше собственных токенов вызова", () => {
    expect(classifyUsage(prev, { m: totals(1.3, 1200, 600) }, 300)).toBe("cumulative"); // прирост 300 = вызов 300
    expect(classifyUsage(prev, { m: totals(1.4, 1300, 650) }, 300)).toBe("cumulative"); // прирост больше (служебные вызовы)
  });

  it("итоги начались заново: счётчики выросли, но прирост меньше токенов самого вызова", () => {
    // Вызов потратил 5000 токенов, а «итоги» всего 5200: вычитание прошлых 1500 дало бы 3700 - меньше 5000.
    expect(classifyUsage(prev, { m: totals(1.1, 3500, 1700) }, 5000)).toBe("restart");
  });

  it("итоги начались заново: счётчик уменьшился или пропала модель", () => {
    expect(classifyUsage(prev, { m: totals(0.2, 100, 50) }, 150)).toBe("restart");
    expect(classifyUsage({ a: totals(1) }, { b: totals(0.5) }, 150)).toBe("restart");
  });

  it("без данных о токенах вызова остаётся прежнее правило (накопительные)", () => {
    expect(classifyUsage(prev, { m: totals(1.3, 1200, 600) })).toBe("cumulative");
    expect(classifyUsage(prev, { m: totals(1.3, 1200, 600) }, 0)).toBe("cumulative");
  });

  it("diffUsage при «начатых заново» итогах берёт их целиком - расход не теряется", () => {
    const delta = diffUsage(prev, { m: totals(1.1, 3500, 1700) }, 5000);
    expect(delta).toHaveLength(1);
    expect(delta[0]).toMatchObject({ model: "m", costUSD: 1.1, inputTokens: 3500, outputTokens: 1700 });
  });
});

describe("месяцы и время", () => {
  it("monthBounds работает по UTC и переходит через год", () => {
    expect(monthBounds(new Date("2026-12-31T23:59:59Z"))).toEqual({
      key: "2026-12",
      start: new Date("2026-12-01T00:00:00Z"),
      end: new Date("2027-01-01T00:00:00Z"),
    });
    expect(monthBounds(new Date("2026-03-01T00:00:00Z")).key).toBe("2026-03");
  });

  it("parseMonthKey принимает только ГГГГ-ММ", () => {
    expect(parseMonthKey("2026-10")?.start).toEqual(new Date("2026-10-01T00:00:00Z"));
    for (const bad of ["2026-13", "2026-00", "26-10", "2026-1", "октябрь", ""]) expect(parseMonthKey(bad)).toBeNull();
  });

  it("humanDuration округляет вверх и говорит по-русски", () => {
    expect(humanDuration(1)).toBe("1 мин");
    expect(humanDuration(59 * 60_000)).toBe("59 мин");
    expect(humanDuration(60 * 60_000)).toBe("1 ч");
    expect(humanDuration(3 * 3_600_000 + 41 * 60_000)).toBe("3 ч 41 мин");
    expect(humanDuration(3 * 24 * 3_600_000)).toBe("3 дн.");
  });
});

const now = new Date("2026-10-07T12:00:00Z");
const status = (overrides: Partial<LimitStatus> = {}): LimitStatus => ({
  month: "2026-10",
  monthResetsAt: new Date("2026-11-01T00:00:00Z"),
  monthSpentUsd: 0,
  monthBudgetUsd: null,
  windowHours: 5,
  windowActive: false,
  windowStartedAt: null,
  windowResetsAt: null,
  windowSpentUsd: 0,
  windowLimitUsd: null,
  ...overrides,
});

describe("blockReason и turnBudgetUsd", () => {
  it("лимитов нет - не блокирует", () => {
    expect(blockReason(status(), now)).toBeNull();
    expect(turnBudgetUsd(status())).toBeUndefined();
  });

  it("блокирует при исчерпанном окне и сообщает время сброса", () => {
    const resetsAt = new Date(now.getTime() + 3 * 3_600_000 + 41 * 60_000);
    const block = blockReason(
      status({ windowActive: true, windowStartedAt: now, windowResetsAt: resetsAt, windowLimitUsd: 1, windowSpentUsd: 1 }),
      now,
    );
    expect(block?.code).toBe("session_limit");
    expect(block?.message).toContain("3 ч 41 мин");
    expect(block?.resetsAt).toEqual(resetsAt);
  });

  it("окно не блокирует, пока не достигнут лимит, и после своего окончания", () => {
    expect(blockReason(status({ windowActive: true, windowResetsAt: now, windowLimitUsd: 1, windowSpentUsd: 0.99 }), now)).toBeNull();
    // Окно закончилось: getLimitStatus отдаёт windowActive=false и нулевой расход - блокировки нет.
    expect(blockReason(status({ windowActive: false, windowLimitUsd: 1 }), now)).toBeNull();
  });

  it("месячный лимит важнее и сбрасывается 1-го числа", () => {
    const block = blockReason(status({ monthBudgetUsd: 10, monthSpentUsd: 10.01, windowLimitUsd: 1, windowActive: true, windowSpentUsd: 5, windowResetsAt: now }), now);
    expect(block?.code).toBe("budget_exceeded");
    expect(block?.resetsAt).toEqual(new Date("2026-11-01T00:00:00Z"));
  });

  it("нулевой лимит окна означает «доступ закрыт» с понятным текстом", () => {
    const block = blockReason(status({ windowLimitUsd: 0 }), now);
    expect(block?.code).toBe("session_limit");
    expect(block?.resetsAt).toBeNull();
  });

  it("потолок хода - меньший из остатков", () => {
    expect(turnBudgetUsd(status({ monthBudgetUsd: 10, monthSpentUsd: 9.5, windowLimitUsd: 1, windowActive: true, windowSpentUsd: 0.2 }))).toBeCloseTo(0.5);
    expect(turnBudgetUsd(status({ windowLimitUsd: 1, windowActive: true, windowSpentUsd: 0.3 }))).toBeCloseTo(0.7);
    expect(turnBudgetUsd(status({ windowLimitUsd: 1, windowActive: false }))).toBe(1);
  });

  it("usageDto отдаёт строки времени и округляет", () => {
    const dto = usageDto(status({ monthSpentUsd: 1.23456789, windowActive: true, windowStartedAt: now, windowResetsAt: now }));
    expect(dto.monthSpentUsd).toBe(1.234568);
    expect(dto.window.startedAt).toBe(now.toISOString());
    expect(dto.window.hours).toBe(5);
  });
});

describe("учёт в БД", () => {
  let handle: DbHandle;
  beforeAll(async () => {
    handle = await openDb({ pglite: "memory" });
    await handle.migrate();
  });
  afterAll(() => handle.close());

  async function setup(window: string | null = "1", monthly: string | null = "10") {
    const email = `u${Math.random().toString(36).slice(2)}@example.com`;
    const [user] = await handle.db
      .insert(users)
      .values({ email, passwordHash: "x", role: "public", monthlyBudgetUsd: monthly, windowLimitUsd: window })
      .returning();
    const [conversation] = await handle.db.insert(conversations).values({ userId: user!.id, entry: "internal", title: "t" }).returning();
    return { user: user!, conversation: conversation! };
  }

  it("openWindow: первое сообщение открывает окно, внутри окна оно то же, после окончания - новое", async () => {
    const { user } = await setup();
    const t0 = new Date("2026-10-07T10:00:00Z");
    expect(await openWindow(handle.db, user.id, 5, t0)).toEqual(t0);
    // Через 4 ч 59 мин окно ещё то же.
    expect(await openWindow(handle.db, user.id, 5, new Date(t0.getTime() + (5 * 60 - 1) * 60_000))).toEqual(t0);
    // Ровно через 5 часов - уже новое, отсчёт идёт с этого сообщения.
    const t1 = new Date(t0.getTime() + 5 * 3_600_000);
    expect(await openWindow(handle.db, user.id, 5, t1)).toEqual(t1);
  });

  it("openWindow атомарен: параллельные вызовы дают одно окно", async () => {
    const { user } = await setup();
    const t = new Date("2026-10-07T10:00:00Z");
    const starts = await Promise.all(Array.from({ length: 8 }, (_, i) => openWindow(handle.db, user.id, 5, new Date(t.getTime() + i))));
    expect(new Set(starts.map((s) => s.getTime())).size).toBe(1);
  });

  it("recordTurnUsage: два хода одной сессии не удваивают расход", async () => {
    const { user, conversation } = await setup();
    const at = new Date("2026-10-07T10:00:00Z");
    const common = { userId: user.id, conversationId: conversation.id, outcome: "success", sessionChanged: false, windowStart: at, at };
    const first = await recordTurnUsage(handle.db, { ...common, next: { m: totals(0.4, 100, 50) } });
    const second = await recordTurnUsage(handle.db, { ...common, next: { m: totals(0.9, 260, 120) } });
    expect(first).toMatchObject({ deltaUsd: 0.4, mode: "first" });
    expect(second).toMatchObject({ deltaUsd: 0.5, mode: "cumulative" });
    const status = await getLimitStatus(handle.db, { ...user, windowStartedAt: at }, 5, at);
    expect(status.monthSpentUsd).toBeCloseTo(0.9, 6);
    expect(status.windowSpentUsd).toBeCloseTo(0.9, 6);
  });

  it("recordTurnUsage: смена сессии сбрасывает базу, нулевой результат её не трогает", async () => {
    const { user, conversation } = await setup();
    const at = new Date("2026-10-07T10:00:00Z");
    const common = { userId: user.id, conversationId: conversation.id, outcome: "success", windowStart: at, at };
    await recordTurnUsage(handle.db, { ...common, sessionChanged: false, next: { m: totals(2) } });
    // Аварийный результат с нулями: ничего не записывается и база не сбрасывается.
    expect((await recordTurnUsage(handle.db, { ...common, sessionChanged: false, next: { m: totalsZero() } })).deltaUsd).toBe(0);
    expect((await recordTurnUsage(handle.db, { ...common, sessionChanged: false, next: { m: totals(2.5) } })).deltaUsd).toBe(0.5);
    // Сессия сменилась: итоги новой сессии берутся целиком, даже если они меньше прошлых.
    expect((await recordTurnUsage(handle.db, { ...common, sessionChanged: true, next: { m: totals(0.3) } })).deltaUsd).toBe(0.3);
  });

  it("расход привязан к окну, в котором начался ход, и к месяцу записи", async () => {
    const { user, conversation } = await setup();
    const w1 = new Date("2026-10-07T10:00:00Z");
    const w2 = new Date("2026-10-07T15:00:00Z");
    const base = { userId: user.id, conversationId: conversation.id, outcome: "success", sessionChanged: false };
    await recordTurnUsage(handle.db, { ...base, next: { m: totals(0.6) }, windowStart: w1, at: new Date("2026-10-07T11:00:00Z") });
    await recordTurnUsage(handle.db, { ...base, next: { m: totals(0.7) }, windowStart: w2, at: new Date("2026-10-07T15:30:00Z") });
    const at = new Date("2026-10-07T16:00:00Z");
    const status = await getLimitStatus(handle.db, { ...user, windowStartedAt: w2 }, 5, at);
    expect(status.windowSpentUsd).toBeCloseTo(0.1, 6);
    expect(status.monthSpentUsd).toBeCloseTo(0.7, 6);
    // Прошлый месяц не попадает в текущий.
    const nextMonth = await getLimitStatus(handle.db, { ...user, windowStartedAt: null }, 5, new Date("2026-11-02T00:00:00Z"));
    expect(nextMonth.monthSpentUsd).toBe(0);
  });

  it("getLimitStatus: окно считается закончившимся ровно через windowHours", async () => {
    const { user } = await setup();
    const start = new Date("2026-10-07T10:00:00Z");
    const end = new Date(start.getTime() + 5 * 3_600_000);
    const inside = await getLimitStatus(handle.db, { ...user, windowStartedAt: start }, 5, new Date(end.getTime() - 1));
    const after = await getLimitStatus(handle.db, { ...user, windowStartedAt: start }, 5, end);
    expect(inside.windowActive).toBe(true);
    expect(inside.windowResetsAt).toEqual(end);
    expect(after.windowActive).toBe(false);
    expect(after.windowResetsAt).toBeNull();
  });

  it("usageReport: итоги по пользователям, пользователи без расхода тоже видны", async () => {
    const a = await setup();
    const b = await setup();
    const at = new Date("2026-09-15T10:00:00Z");
    await recordTurnUsage(handle.db, { userId: a.user.id, conversationId: a.conversation.id, outcome: "success", sessionChanged: false, windowStart: at, at, next: { m: totals(1.25, 1000, 400) } });
    const report = await usageReport(handle.db, parseMonthKey("2026-09")!);
    const rowA = report.rows.find((r) => r.userId === a.user.id)!;
    const rowB = report.rows.find((r) => r.userId === b.user.id)!;
    expect(rowA).toMatchObject({ turns: 1, inputTokens: 1000, outputTokens: 400, costUsd: 1.25 });
    expect(rowB).toMatchObject({ turns: 0, costUsd: 0 });
    expect(report.totalUsd).toBeGreaterThanOrEqual(1.25);
    expect(report.rows[0]!.costUsd).toBeGreaterThanOrEqual(report.rows.at(-1)!.costUsd);
  });
});

export type { Snapshot };
