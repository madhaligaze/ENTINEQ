import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { conversations, messages, usageEvents } from "../src/db/schema.js";
import { monthBounds } from "../src/usage/ledger.js";
import {
  asCookie,
  createHarness,
  directSocket,
  internalHeaders,
  internalSocket,
  kinds,
  makePublic,
  makeTrusted,
  openSocket,
  ownerCookie,
  SECRET,
  type Harness,
} from "./helpers.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());

type Ev = { kind: string; [key: string]: unknown };
const of = (events: Ev[], kind: string) => events.find((e) => e.kind === kind) as Ev;
const lastOf = (events: Ev[], kind: string) => [...events].reverse().find((e) => e.kind === kind) as Ev;
const usageOf = (events: Ev[]) => lastOf(events, "usage").usage as {
  monthSpentUsd: number;
  monthBudgetUsd: number | null;
  window: { active: boolean; startedAt: string | null; resetsAt: string | null; spentUsd: number; limitUsd: number | null };
};
const rowsOf = (userId: string) => h.db.select().from(usageEvents).where(eq(usageEvents.userId, userId)).orderBy(asc(usageEvents.id));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("диалог через прямую дверь (владелец и доверенные)", () => {
  it("полный ход: события, сохранённые сообщения и учёт расходов", async () => {
    const user = await makeTrusted(h);
    const socket = await directSocket(h, user.cookie);
    const events = await socket.turn({ text: "привет" });

    expect(kinds(events)[0]).toBe("conversation");
    expect(kinds(events).at(-1)).toBe("done");
    expect(kinds(events).indexOf("usage")).toBeLessThan(kinds(events).indexOf("done"));
    expect(events.filter((e) => e.kind === "delta").map((e) => e.text).join("")).toBe("Эхо: привет");
    expect(of(events, "text").text).toBe("Эхо: привет");
    expect(of(events, "conversation")).toMatchObject({ isNew: true, title: "привет" });

    const conversationId = of(events, "conversation").id as string;
    const saved = await h.db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(asc(messages.id));
    expect(saved.map((m) => [m.role, m.content])).toEqual([["user", "привет"], ["assistant", "Эхо: привет"]]);

    const usage = await rowsOf(user.id);
    expect(usage).toHaveLength(1);
    expect(Number(usage[0]!.costUsd)).toBeCloseTo(0.01, 8);
    expect(usage[0]).toMatchObject({ model: "fake-model", outcome: "success" });
    expect(usageOf(events).window).toMatchObject({ active: true, spentUsd: 0.01 });
    socket.close();
  });

  it("продолжение диалога: накопительные итоги SDK не задваивают расход", async () => {
    const user = await makeTrusted(h);
    const socket = await directSocket(h, user.cookie);
    const first = await socket.turn({ text: "один" });
    const conversationId = of(first, "conversation").id as string;
    const second = await socket.turn({ text: "два", conversationId });
    const third = await socket.turn({ text: "три", conversationId });

    expect(of(second, "conversation")).toMatchObject({ id: conversationId, isNew: false });
    const rows = await rowsOf(user.id);
    expect(rows.map((r) => Number(r.costUsd))).toEqual([0.01, 0.01, 0.01]);
    expect(usageOf(third).monthSpentUsd).toBeCloseTo(0.03, 6);
    expect(usageOf(third).window.spentUsd).toBeCloseTo(0.03, 6);

    const messagesList = await h.db.select().from(messages).where(eq(messages.conversationId, conversationId));
    expect(messagesList).toHaveLength(6);
    socket.close();
  });

  it("перезапуск процесса агента посреди диалога: итоги SDK начались заново, но расход всё равно учтён", async () => {
    const user = await makeTrusted(h);
    const socket = await directSocket(h, user.cookie);
    const first = await socket.turn({ text: "короткий первый вопрос" });
    const conversationId = of(first, "conversation").id as string;
    await socket.turn({ text: "второй", conversationId });
    h.runner.forgetTotals(); // как если бы SDK не нашёл в транскрипте сохранённых итогов
    await socket.turn({ text: "третий вопрос заметно длиннее предыдущих, чтобы счётчики выросли", conversationId });
    h.runner.forgetTotals();
    const last = await socket.turn({ text: "четвёртый", conversationId });

    const rows = await rowsOf(user.id);
    expect(rows.map((r) => Number(r.costUsd))).toEqual([0.01, 0.01, 0.01, 0.01]); // ни один ход не потерян
    expect(usageOf(last).monthSpentUsd).toBeCloseTo(0.04, 6);
    socket.close();
  });

  it("список диалогов и история доступны по REST", async () => {
    const user = await makeTrusted(h);
    const socket = await directSocket(h, user.cookie);
    const events = await socket.turn({ text: "  длинный   вопрос\nна двух строках  " });
    const id = of(events, "conversation").id as string;
    socket.close();

    const list = (await h.app.inject({ method: "GET", url: "/api/conversations", headers: asCookie(user.cookie) })).json().conversations;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id, title: "длинный вопрос на двух строках" });
    const history = (await h.app.inject({ method: "GET", url: `/api/conversations/${id}/messages`, headers: asCookie(user.cookie) })).json().messages;
    expect(history.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);
  });

  it("длинный заголовок обрезается", async () => {
    const user = await makeTrusted(h);
    const socket = await directSocket(h, user.cookie);
    const events = await socket.turn({ text: "я".repeat(200) });
    expect((of(events, "conversation").title as string).length).toBe(61);
    socket.close();
  });
});

describe("права по уровню доверия", () => {
  it("доверенный получает терминал, публичный — только чат", async () => {
    const trusted = await makeTrusted(h);
    const pub = await makePublic(h);
    const a = await directSocket(h, trusted.cookie);
    const b = await internalSocket(h, pub.token);

    const withTool = await a.turn({ text: "[[bash]] покажи" });
    const without = await b.turn({ text: "[[bash]] покажи" });
    expect(of(withTool, "tool")).toMatchObject({ name: "Bash", summary: "echo hello" });
    expect(kinds(without)).not.toContain("tool");

    const toolRows = await h.db.select().from(messages).where(eq(messages.role, "tool"));
    expect(toolRows.some((row) => row.content === "Bash: echo hello")).toBe(true);
    a.close();
    b.close();
  });
});

describe("проверка личности на WebSocket", () => {
  it("прямая дверь: без cookie и с подделкой соединение закрывается кодом 4401", async () => {
    const none = await openSocket(`${h.wsUrl}/ws`, { origin: h.baseUrl });
    expect(await none.closed).toBe(4401);
    const fake = await directSocket(h, "forged-token");
    expect(await fake.closed).toBe(4401);
  });

  it("прямая дверь: чужой Origin отклоняется ещё до открытия соединения", async () => {
    const owner = await ownerCookie(h);
    await expect(directSocket(h, owner, "https://evil.example")).rejects.toThrow("HTTP 403");
  });

  it("прямая дверь: токен публичного пользователя не подходит", async () => {
    const pub = await makePublic(h);
    expect(await (await directSocket(h, pub.token)).closed).toBe(4401);
  });

  it("внутренняя дверь: без секрета, с неверным секретом и с секретом в адресе — 401", async () => {
    const pub = await makePublic(h);
    await expect(openSocket(`${h.wsUrl}/internal/ws`, { "x-user-token": pub.token })).rejects.toThrow("HTTP 401");
    await expect(internalSocket(h, pub.token, "wrong-secret")).rejects.toThrow("HTTP 401");
    await expect(openSocket(`${h.wsUrl}/internal/ws?key=${SECRET}`, { "x-user-token": pub.token })).rejects.toThrow("HTTP 401");
  });

  it("внутренняя дверь: секрет верный, но токена нет или он чужой двери — 4401", async () => {
    const owner = await ownerCookie(h);
    expect(await (await openSocket(`${h.wsUrl}/internal/ws`, internalHeaders())).closed).toBe(4401);
    expect(await (await internalSocket(h, owner)).closed).toBe(4401);
    expect(await (await internalSocket(h, "forged-token")).closed).toBe(4401);
  });

  it("выход из аккаунта действует на уже открытое соединение", async () => {
    const pub = await makePublic(h);
    const socket = await internalSocket(h, pub.token);
    expect(kinds(await socket.turn({ text: "до выхода" }))).toContain("text");
    await h.app.inject({ method: "POST", url: "/internal/auth/logout", headers: internalHeaders(pub.token) });
    const events = await socket.turn({ text: "после выхода" });
    expect(events.map((e) => e.kind)).toEqual(["error", "done"]);
    expect(of(events, "error").code).toBe("unauthorized");
    expect(await socket.closed).toBe(4401);
  });

  it("отключение пользователя администратором действует сразу", async () => {
    const user = await makeTrusted(h);
    const socket = await directSocket(h, user.cookie);
    expect(kinds(await socket.turn({ text: "жив" }))).toContain("text");
    await h.app.inject({ method: "PATCH", url: `/api/admin/users/${user.id}`, headers: asCookie(await ownerCookie(h)), payload: { isActive: false } });
    expect(of(await socket.turn({ text: "ещё" }), "error").code).toBe("unauthorized");
    expect(await socket.closed).toBe(4401);
  });

  it("сообщение, отправленное в ту же миллисекунду, когда соединение открылось, не теряется", async () => {
    // Регрессия: обработчик сообщений раньше вешался после асинхронной проверки сессии, и на настоящем
    // Postgres (где она занимает миллисекунды) первое сообщение пропадало.
    const { WebSocket } = await import("ws");
    const user = await makeTrusted(h);
    for (let attempt = 0; attempt < 5; attempt++) {
      const events: Ev[] = [];
      const ws = new WebSocket(`${h.wsUrl}/ws`, { headers: { cookie: `entineq_agent_session=${user.cookie}`, origin: h.baseUrl } });
      const finished = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("ответа нет: сообщение потеряно")), 5000);
        ws.on("message", (data) => {
          const event = JSON.parse(data.toString()) as Ev;
          events.push(event);
          if (event.kind === "done") {
            clearTimeout(timer);
            resolve();
          }
        });
        ws.on("open", () => ws.send(JSON.stringify({ type: "user", text: `мгновенное ${attempt}` })));
      });
      await finished;
      expect(of(events, "text").text).toBe(`Эхо: мгновенное ${attempt}`);
      ws.close();
    }
  });

  it("чужой диалог недоступен", async () => {
    const a = await makePublic(h);
    const b = await makePublic(h);
    const sa = await internalSocket(h, a.token);
    const sb = await internalSocket(h, b.token);
    const conversationId = of(await sa.turn({ text: "моё" }), "conversation").id as string;
    const stolen = await sb.turn({ text: "подсмотрю", conversationId });
    expect(of(stolen, "error").code).toBe("not_found");
    const rows = await h.db.select().from(messages).where(eq(messages.conversationId, conversationId));
    expect(rows).toHaveLength(2); // чужое сообщение в диалог не попало
    sa.close();
    sb.close();
  });
});

describe("лимит окна сессии (как 5-часовое окно у подписок)", () => {
  const at = async (fn: (t0: Date) => Promise<void>) => {
    const original = h.clock.now;
    const t0 = new Date(Math.floor(Date.now() / 1000) * 1000);
    h.clock.now = t0;
    try {
      await fn(t0);
    } finally {
      h.clock.now = original;
    }
  };

  it("окно открывается первым сообщением, при исчерпании блокирует до сброса, потом открывается заново", async () => {
    await at(async (t0) => {
      const user = await makePublic(h, { window: 0.02, monthly: null });
      const socket = await internalSocket(h, user.token);
      const hour = 3_600_000;

      const first = await socket.turn({ text: "первое" });
      expect(usageOf(first).window).toMatchObject({ active: true, spentUsd: 0.01, limitUsd: 0.02, startedAt: t0.toISOString() });
      expect(usageOf(first).window.resetsAt).toBe(new Date(t0.getTime() + 5 * hour).toISOString());
      const conversationId = of(first, "conversation").id as string;

      // Через час окно прежнее: отсчёт идёт от первого сообщения, а не от последнего.
      h.clock.now = new Date(t0.getTime() + hour);
      const second = await socket.turn({ text: "второе", conversationId });
      expect(usageOf(second).window).toMatchObject({ startedAt: t0.toISOString(), spentUsd: 0.02 });

      // Лимит достигнут: агент не запускается, ничего не тратится и не сохраняется.
      h.clock.now = new Date(t0.getTime() + 2 * hour);
      const blocked = await socket.turn({ text: "третье", conversationId });
      expect(blocked.map((e) => e.kind)).toEqual(["error", "done"]);
      expect(of(blocked, "error")).toMatchObject({ code: "session_limit", resetsAt: new Date(t0.getTime() + 5 * hour).toISOString() });
      expect(of(blocked, "error").message).toContain("3 ч");
      expect(await rowsOf(user.id)).toHaveLength(2);
      expect(await h.db.select().from(messages).where(eq(messages.conversationId, conversationId))).toHaveLength(4);

      // Окно закончилось: новое сообщение открывает новое окно с этого момента.
      const reset = new Date(t0.getTime() + 5 * hour);
      h.clock.now = reset;
      const fourth = await socket.turn({ text: "четвёртое", conversationId });
      expect(kinds(fourth)).toContain("text");
      expect(usageOf(fourth).window).toMatchObject({ active: true, startedAt: reset.toISOString(), spentUsd: 0.01 });
      socket.close();
    });
  });

  it("блокировка видна и в профиле: окно активно, расход равен лимиту", async () => {
    await at(async () => {
      const user = await makePublic(h, { window: 0.01, monthly: null });
      const socket = await internalSocket(h, user.token);
      await socket.turn({ text: "раз" });
      const me = await h.app.inject({ method: "GET", url: "/internal/me", headers: internalHeaders(user.token) });
      expect(me.json().usage.window).toMatchObject({ active: true, spentUsd: 0.01, limitUsd: 0.01 });
      socket.close();
    });
  });

  it("окно одного пользователя не влияет на другого", async () => {
    await at(async () => {
      const a = await makePublic(h, { window: 0.01, monthly: null });
      const b = await makePublic(h, { window: 0.01, monthly: null });
      const sa = await internalSocket(h, a.token);
      const sb = await internalSocket(h, b.token);
      await sa.turn({ text: "трачу" });
      expect(of(await sa.turn({ text: "ещё" }), "error").code).toBe("session_limit");
      expect(kinds(await sb.turn({ text: "я свободен" }))).toContain("text");
      sa.close();
      sb.close();
    });
  });

  it("дорогой ход, превысивший остаток окна, останавливается и учитывается", async () => {
    await at(async (t0) => {
      const user = await makePublic(h, { window: 1, monthly: null });
      const socket = await internalSocket(h, user.token);
      const events = await socket.turn({ text: "[[expensive]]" });
      expect(of(events, "error")).toMatchObject({ code: "session_limit", resetsAt: new Date(t0.getTime() + 5 * 3_600_000).toISOString() });
      expect(usageOf(events).window.spentUsd).toBeCloseTo(1.5, 6);
      const rows = await rowsOf(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.outcome).toBe("error_max_budget_usd");
      expect(of(await socket.turn({ text: "ещё" }), "error").code).toBe("session_limit");
      socket.close();
    });
  });

  it("нулевой лимит окна закрывает доступ с понятным текстом", async () => {
    const user = await makePublic(h, { window: 0, monthly: null });
    const socket = await internalSocket(h, user.token);
    const events = await socket.turn({ text: "можно?" });
    expect(of(events, "error")).toMatchObject({ code: "session_limit" });
    expect(of(events, "error").message).toContain("равен нулю");
    socket.close();
  });

  it("месячный лимит блокирует до 1-го числа следующего месяца", async () => {
    await at(async (t0) => {
      const user = await makePublic(h, { window: null, monthly: 0.015 });
      const socket = await internalSocket(h, user.token);
      const conversationId = of(await socket.turn({ text: "раз" }), "conversation").id as string;
      expect(kinds(await socket.turn({ text: "два", conversationId }))).toContain("text"); // 0.02 ≥ 0.015
      const blocked = await socket.turn({ text: "три", conversationId });
      expect(of(blocked, "error")).toMatchObject({ code: "budget_exceeded", resetsAt: monthBounds(t0).end.toISOString() });
      socket.close();
    });
  });

  it("потолок одного запроса защищает пользователя без лимитов", async () => {
    const user = await makeTrusted(h, { monthly: null, window: null });
    const socket = await directSocket(h, user.cookie);
    expect(kinds(await socket.turn({ text: "[[expensive]]" }))).toContain("text"); // 1.5 < 10: проходит
    h.cfg.turnMaxBudgetUsd = 1;
    try {
      const events = await socket.turn({ text: "[[expensive]]" });
      expect(of(events, "error").code).toBe("budget_exceeded");
    } finally {
      h.cfg.turnMaxBudgetUsd = 10;
    }
    socket.close();
  });
});

describe("ошибки агента", () => {
  it("доверенный видит причину без секретов, публичный — только общий текст", async () => {
    const trusted = await makeTrusted(h);
    const pub = await makePublic(h);
    const a = await directSocket(h, trusted.cookie);
    const b = await internalSocket(h, pub.token);

    const trustedEvents = await a.turn({ text: "[[fail]]" });
    const message = of(trustedEvents, "error").message as string;
    expect(of(trustedEvents, "error").code).toBe("agent_error");
    expect(message).toContain("Симулированный сбой");
    expect(message).toContain("sk-ant-***");
    expect(message).not.toContain("ABCDEFGHIJKLMNOP");
    expect(kinds(trustedEvents).at(-1)).toBe("done");

    const publicEvents = await b.turn({ text: "[[fail]]" });
    expect(of(publicEvents, "error")).toMatchObject({ code: "agent_error", message: "Не удалось получить ответ. Попробуйте ещё раз." });

    expect(await rowsOf(trusted.id)).toHaveLength(0);
    expect(await rowsOf(pub.id)).toHaveLength(0);
    // Запрос пользователя при этом сохранён, диалог не потерян.
    expect(await h.db.select().from(conversations).where(eq(conversations.userId, trusted.id))).toHaveLength(1);

    // После сбоя сервис продолжает работать для того же пользователя.
    expect(kinds(await a.turn({ text: "жив?" }))).toContain("text");
    a.close();
    b.close();
  });

  it("слишком долгий ход прерывается по таймауту", async () => {
    const user = await makeTrusted(h);
    const socket = await directSocket(h, user.cookie);
    h.cfg.turnTimeoutMs = 50;
    try {
      const events = await socket.turn({ text: "[[slow]]" });
      expect(of(events, "error").code).toBe("timeout");
    } finally {
      h.cfg.turnTimeoutMs = 600_000;
    }
    expect(kinds(await socket.turn({ text: "после таймаута" }))).toContain("text");
    socket.close();
  });
});

describe("конкурентность", () => {
  it("второй запрос того же пользователя, пока идёт первый, получает busy (даже с другого сокета)", async () => {
    const user = await makeTrusted(h);
    const a = await directSocket(h, user.cookie);
    const b = await directSocket(h, user.cookie);
    const running = a.turn({ text: "[[slow]]" });
    await sleep(200);
    const rejected = await b.turn({ text: "параллельно" });
    expect(of(rejected, "error").code).toBe("busy");
    expect(kinds(await running)).toContain("text");
    expect(await rowsOf(user.id)).toHaveLength(1);
    a.close();
    b.close();
  });

  it("второе сообщение на том же сокете во время хода отклоняется, первое доходит до конца", async () => {
    const user = await makeTrusted(h);
    const socket = await directSocket(h, user.cookie);
    socket.ws.send(JSON.stringify({ type: "user", text: "[[slow]]" }));
    await sleep(200);
    socket.ws.send(JSON.stringify({ type: "user", text: "поспешное" }));
    for (let i = 0; i < 100 && !socket.events.some((e) => e.kind === "done"); i++) await sleep(50);
    // done один — от настоящего хода; отказ «busy» его не посылает, иначе интерфейс счёл бы ход законченным.
    const busyAt = socket.events.findIndex((e) => e.kind === "error" && e.code === "busy");
    const doneAt = socket.events.findIndex((e) => e.kind === "done");
    expect(busyAt).toBeGreaterThanOrEqual(0);
    expect(doneAt).toBeGreaterThan(busyAt);
    expect(socket.events.filter((e) => e.kind === "done")).toHaveLength(1);
    expect(socket.events.some((e) => e.kind === "text")).toBe(true);
    expect(await rowsOf((await h.db.select().from(conversations).orderBy(asc(conversations.createdAt)).then((rows) => rows.at(-1)!)).userId)).toHaveLength(1);
    socket.close();
  });

  it("общий предел одновременных ходов: лишним отвечаем server_busy и не теряем их", async () => {
    const a = await makeTrusted(h);
    const b = await makeTrusted(h);
    const sa = await directSocket(h, a.cookie);
    const sb = await directSocket(h, b.cookie);
    h.cfg.maxConcurrentTurns = 1;
    try {
      const running = sa.turn({ text: "[[slow]]" });
      await sleep(200);
      expect(of(await sb.turn({ text: "не влезаю" }), "error").code).toBe("server_busy");
      await running;
    } finally {
      h.cfg.maxConcurrentTurns = 4;
    }
    expect(kinds(await sb.turn({ text: "теперь можно" }))).toContain("text");
    sa.close();
    sb.close();
  });

  it("много пользователей одновременно: расходы не смешиваются", async () => {
    h.cfg.maxConcurrentTurns = 64;
    try {
      const users = await Promise.all(Array.from({ length: 8 }, () => makePublic(h)));
      const results = await Promise.all(
        users.map(async (user, index) => {
          const socket = await internalSocket(h, user.token);
          const events = await socket.turn({ text: `сообщение ${index}` });
          socket.close();
          return { user, events, index };
        }),
      );
      for (const { user, events, index } of results) {
        expect(of(events, "text").text).toBe(`Эхо: сообщение ${index}`);
        const rows = await rowsOf(user.id);
        expect(rows).toHaveLength(1);
        expect(Number(rows[0]!.costUsd)).toBeCloseTo(0.01, 8);
      }
    } finally {
      h.cfg.maxConcurrentTurns = 4;
    }
  });

  it("закрытие вкладки посреди хода не теряет ни ответ, ни расход", async () => {
    const user = await makeTrusted(h);
    const socket = await directSocket(h, user.cookie);
    socket.ws.send(JSON.stringify({ type: "user", text: "[[slow]] долгий" }));
    await sleep(150);
    socket.close();
    await h.chat.drain(10_000);
    const rows = await rowsOf(user.id);
    expect(rows).toHaveLength(1);
    const [conversation] = await h.db.select().from(conversations).where(eq(conversations.userId, user.id));
    const saved = await h.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversation!.id), eq(messages.role, "assistant")));
    expect(saved).toHaveLength(1);
  });

  it("drain ждёт текущие ходы и сразу возвращается, когда их нет", async () => {
    const idle = Date.now();
    await h.chat.drain(5000);
    expect(Date.now() - idle).toBeLessThan(500);

    const user = await makeTrusted(h);
    const socket = await directSocket(h, user.cookie);
    const running = socket.turn({ text: "[[slow]]" });
    await sleep(100);
    const start = Date.now();
    await h.chat.drain(10_000);
    expect(Date.now() - start).toBeGreaterThan(800);
    await running;
    socket.close();
  });
});

describe("проверка сообщений от интерфейса", () => {
  it("мусор отклоняется с понятной ошибкой, соединение остаётся рабочим", async () => {
    const user = await makeTrusted(h);
    const socket = await directSocket(h, user.cookie);
    const bad: unknown[] = [{ type: "user" }, { type: "user", text: "   " }, { type: "ping" }, { type: "user", text: "x".repeat(20_001) }, { type: "user", text: "ок", conversationId: "не-uuid" }];
    for (const payload of bad) {
      const events = await socket.turn(payload as Record<string, unknown>).then((e) => e);
      expect(of(events, "error").code).toBe("invalid_message");
      expect(kinds(events).at(-1)).toBe("done");
    }
    // Не JSON вовсе.
    const start = socket.events.length;
    const done = new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (socket.events.slice(start).some((e) => e.kind === "done")) {
          clearInterval(timer);
          resolve();
        }
      }, 20);
    });
    socket.ws.send("это не json");
    await done;
    expect(socket.events.slice(start).some((e) => e.kind === "error" && e.code === "invalid_message")).toBe(true);
    // И после всего этого обычное сообщение работает.
    expect(kinds(await socket.turn({ text: "нормальное" }))).toContain("text");
    expect(await rowsOf(user.id)).toHaveLength(1);
    socket.close();
  });
});
