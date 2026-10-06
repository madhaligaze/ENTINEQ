import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { browserSocket, createHarness, kinds, openSocket, register, SECRET, sleep, type Harness } from "./helpers.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => {
  h.core.mode = "ok";
});

const eventOf = (events: { kind: string }[], kind: string) => events.find((e) => e.kind === kind) as Record<string, unknown>;

describe("прокладка WebSocket между браузером и ядром", () => {
  it("без cookie соединение закрывается кодом 4401", async () => {
    const socket = await browserSocket(h);
    expect(await socket.closed).toBe(4401);
  });

  it("чужой Origin отклоняется до открытия соединения", async () => {
    const user = await register(h);
    await expect(browserSocket(h, user.cookie, "https://evil.example")).rejects.toThrow("HTTP 403");
  });

  it("ход диалога проходит через прокладку; ядро получает секрет и токен, браузер их не видит", async () => {
    const user = await register(h);
    const socket = await browserSocket(h, user.cookie);
    const events = await socket.turn({ text: "привет" });

    expect(kinds(events)).toEqual(["conversation", "delta", "text", "usage", "done"]);
    expect(eventOf(events, "text").text).toBe("Эхо: привет");
    expect(JSON.stringify(events)).not.toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain(user.cookie);

    const record = h.core.ws.at(-1)!;
    expect(record.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(record.headers["x-user-token"]).toBe(user.cookie);
    expect(record.received).toEqual([{ type: "user", text: "привет" }]);
    socket.close();
  });

  it("продолжение диалога: conversationId доходит до ядра", async () => {
    const user = await register(h);
    const socket = await browserSocket(h, user.cookie);
    const first = await socket.turn({ text: "один" });
    const id = eventOf(first, "conversation").id as string;
    const second = await socket.turn({ text: "два", conversationId: id });
    expect(eventOf(second, "conversation")).toMatchObject({ id, isNew: false });
    expect(h.core.ws.at(-1)!.received[1]).toEqual({ type: "user", text: "два", conversationId: id });
    socket.close();
  });

  it("сообщение, отправленное в миг открытия соединения, не теряется (пока ядро ещё подключается)", async () => {
    const user = await register(h);
    for (let attempt = 0; attempt < 5; attempt++) {
      const ws = new WebSocket(`${h.wsUrl}/ws`, { headers: { origin: h.baseUrl, cookie: `entineq_session=${user.cookie}` } });
      const events: { kind: string; text?: string }[] = [];
      const finished = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("ответа нет: сообщение потеряно")), 5000);
        ws.on("message", (data) => {
          const event = JSON.parse(data.toString());
          events.push(event);
          if (event.kind === "done") {
            clearTimeout(timer);
            resolve();
          }
        });
        ws.on("open", () => ws.send(JSON.stringify({ type: "user", text: `мгновенно ${attempt}` })));
      });
      await finished;
      expect(events.find((e) => e.kind === "text")?.text).toBe(`Эхо: мгновенно ${attempt}`);
      ws.close();
    }
  });

  it("мусорные сообщения отклоняются в прокладке и до ядра не доходят", async () => {
    const user = await register(h);
    const socket = await browserSocket(h, user.cookie);
    // Сначала один нормальный ход: после него соединение с ядром точно установлено и его запись - последняя.
    expect(kinds(await socket.turn({ text: "старт" }))).toContain("text");
    const record = h.core.ws.at(-1)!;
    const before = record.received.length;
    for (const payload of [{ type: "user" }, { type: "user", text: "   " }, { type: "ping" }, { type: "user", text: "x".repeat(20_001) }, { type: "user", text: "ок", conversationId: "не-uuid" }]) {
      const events = await socket.turn(payload);
      expect(eventOf(events, "error").code).toBe("invalid_message");
      expect(kinds(events).at(-1)).toBe("done");
    }
    const start = socket.events.length;
    socket.ws.send("это не json");
    for (let i = 0; i < 50 && !socket.events.slice(start).some((e) => e.kind === "done"); i++) await sleep(20);
    expect(socket.events.slice(start).some((e) => e.kind === "error" && e.code === "invalid_message")).toBe(true);
    expect(record.received.length).toBe(before);
    expect(kinds(await socket.turn({ text: "нормальное" }))).toContain("text");
    expect(record.received.length).toBe(before + 1);
    socket.close();
  });

  it("отказ во время идущего хода не посылает лишний done", async () => {
    const user = await register(h);
    const socket = await browserSocket(h, user.cookie);
    socket.ws.send(JSON.stringify({ type: "user", text: "[[slow]] долго" }));
    await sleep(150);
    socket.ws.send(JSON.stringify({ type: "user" })); // некорректное, пока ход идёт
    for (let i = 0; i < 100 && !socket.events.some((e) => e.kind === "text"); i++) await sleep(20);
    await sleep(50);
    expect(socket.events.filter((e) => e.kind === "done")).toHaveLength(1);
    expect(socket.events.some((e) => e.kind === "error" && e.code === "invalid_message")).toBe(true);
    expect(kinds(socket.events).indexOf("error")).toBeLessThan(kinds(socket.events).indexOf("done"));
    socket.close();
  });

  it("если ядро закрывает соединение кодом 4401 - браузер получает 4401 (интерфейс покажет вход)", async () => {
    const user = await register(h);
    const socket = await browserSocket(h, user.cookie);
    socket.ws.send(JSON.stringify({ type: "user", text: "[[4401]]" }));
    expect(await socket.closed).toBe(4401);
  });

  it("если ядро не узнаёт токен - 4401", async () => {
    const socket = await browserSocket(h, "unknown-token-0123456789-abcdef");
    expect(await socket.closed).toBe(4401);
  });

  it("обрыв у ядра закрывает соединение с браузером, не оставляя висеть", async () => {
    const user = await register(h);
    const socket = await browserSocket(h, user.cookie);
    socket.ws.send(JSON.stringify({ type: "user", text: "[[drop]]" }));
    expect(await socket.closed).toBe(1011);
  });

  it("закрытие вкладки закрывает и соединение с ядром", async () => {
    const user = await register(h);
    const socket = await browserSocket(h, user.cookie);
    await socket.turn({ text: "привет" });
    const record = h.core.ws.at(-1)!;
    socket.close();
    await socket.closed;
    for (let i = 0; i < 50 && !record.closed; i++) await sleep(20);
    expect(record.closed).toBe(true);
  });

  it("ядро отклонило секрет при подключении → понятная ошибка и закрытие, без паники", async () => {
    const user = await register(h);
    h.core.mode = "secret-reject";
    const socket = await browserSocket(h, user.cookie);
    const code = await socket.closed;
    expect(code).toBe(1011);
    expect(socket.events.map((e) => e.kind)).toEqual(["error", "done"]);
    expect(socket.events[0]!.code).toBe("upstream_unavailable");
    expect(JSON.stringify(socket.events)).not.toMatch(/секрет|SECRET|Bearer/i);
  });

  it("ядро недоступно → ошибка и закрытие 1011", async () => {
    const own = await createHarness();
    const user = await register(own);
    await own.core.close();
    try {
      const socket = await browserSocket(own, user.cookie);
      expect(await socket.closed).toBe(1011);
      expect(socket.events.map((e) => e.kind)).toEqual(["error", "done"]);
    } finally {
      await own.app.close();
    }
  });

  it("слишком большое сообщение разрывает соединение", async () => {
    const user = await register(h);
    const socket = await browserSocket(h, user.cookie);
    socket.ws.send("x".repeat(70_000));
    // 1009 - «слишком большое сообщение»; клиент может увидеть и 1006, если TCP закрылся сразу вслед за кадром закрытия.
    expect([1006, 1009]).toContain(await socket.closed);
  });

  it("открытия WebSocket с одного адреса ограничены по частоте", async () => {
    const own = await createHarness({ RATE_LIMIT_WS_PER_MIN: "3" });
    try {
      const user = await register(own);
      for (let i = 0; i < 3; i++) (await browserSocket(own, user.cookie)).close();
      await expect(browserSocket(own, user.cookie)).rejects.toThrow("HTTP 429");
    } finally {
      await own.close();
    }
  });

  it("несколько пользователей одновременно: ответы не смешиваются", async () => {
    const users = await Promise.all(Array.from({ length: 6 }, () => register(h)));
    const results = await Promise.all(
      users.map(async (user, index) => {
        const socket = await browserSocket(h, user.cookie);
        const events = await socket.turn({ text: `сообщение ${index}` });
        socket.close();
        return { index, text: eventOf(events, "text").text };
      }),
    );
    for (const { index, text } of results) expect(text).toBe(`Эхо: сообщение ${index}`);
  });

  it("открытие без обращения: сокет, не пославший ничего, спокойно закрывается", async () => {
    const user = await register(h);
    const socket = await openSocket(`${h.wsUrl}/ws`, { origin: h.baseUrl, cookie: `entineq_session=${user.cookie}` });
    socket.close();
    await socket.closed;
  });
});
