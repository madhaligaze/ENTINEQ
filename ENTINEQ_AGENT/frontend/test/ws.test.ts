import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createHarness, openSocket, sleep, type Harness } from "./helpers.js";

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(() => h.close());
beforeEach(() => {
  h.backend.mode = "ok";
  h.backend.delayMs = 0;
});

const lastRecord = () => h.backend.ws.at(-1)!;

describe("прокладка WebSocket", () => {
  it("кадры идут в обе стороны; бэкенд получает cookie и Origin, а IP и сайт - заголовками X-Forwarded-*", async () => {
    const socket = await openSocket(`${h.wsUrl}/ws`, { cookie: "entineq_session=tok", origin: "https://front.example", "user-agent": "ws-test" });
    socket.ws.send("привет");
    expect(await socket.next()).toBe("эхо:привет");
    const seen = lastRecord().headers;
    expect(seen.cookie).toBe("entineq_session=tok");
    expect(seen.origin).toBe("https://front.example");
    expect(seen["user-agent"]).toBe("ws-test");
    expect(seen["x-forwarded-for"]).toBe("127.0.0.1");
    expect(seen["x-forwarded-proto"]).toBe("http");
    expect(lastRecord().url).toBe("/ws");
    socket.close();
  });

  it("чужие служебные заголовки до бэкенда не доходят", async () => {
    const socket = await openSocket(`${h.wsUrl}/ws`, { authorization: "Bearer stolen", "x-user-token": "forged", "x-forwarded-for": "6.6.6.6" });
    socket.ws.send("x");
    await socket.next();
    const seen = lastRecord().headers;
    expect(seen.authorization).toBeUndefined();
    expect(seen["x-user-token"]).toBeUndefined();
    expect(seen["x-forwarded-for"]).toBe("127.0.0.1");
    socket.close();
  });

  it("бинарные кадры не искажаются", async () => {
    const socket = await openSocket(`${h.wsUrl}/ws`);
    const payload = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
    const echoed = new Promise<Buffer>((resolve) => socket.ws.once("message", (data) => resolve(data as Buffer)));
    socket.ws.send(payload);
    expect(Buffer.compare(await echoed, payload)).toBe(0);
    expect(lastRecord().received.at(-1)).toEqual({ data: "<binary>", binary: true });
    socket.close();
  });

  it("порядок сообщений сохраняется", async () => {
    const socket = await openSocket(`${h.wsUrl}/ws`);
    for (let i = 0; i < 30; i++) socket.ws.send(`m${i}`);
    for (let i = 0; i < 30; i++) expect(await socket.next()).toBe(`эхо:m${i}`);
    socket.close();
  });

  it("сообщение, отправленное в миг открытия (пока соединение с бэкендом ещё устанавливается), не теряется", async () => {
    h.backend.delayMs = 300; // рукопожатие с бэкендом занимает заметное время
    for (let attempt = 0; attempt < 3; attempt++) {
      const ws = new WebSocket(`${h.wsUrl}/ws`);
      const replies: string[] = [];
      const done = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("ответа нет: сообщение потеряно")), 5000);
        ws.on("message", (data) => {
          replies.push(data.toString());
          if (replies.length === 2) {
            clearTimeout(timer);
            resolve();
          }
        });
        ws.on("open", () => {
          ws.send(`первое ${attempt}`);
          ws.send(`второе ${attempt}`);
        });
      });
      await done;
      expect(replies).toEqual([`эхо:первое ${attempt}`, `эхо:второе ${attempt}`]);
      ws.close();
    }
  });

  it("слишком много сообщений, пока бэкенд не ответил, - соединение закрывается (защита памяти)", async () => {
    h.backend.delayMs = 800;
    const ws = new WebSocket(`${h.wsUrl}/ws`);
    const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
    ws.on("open", () => {
      for (let i = 0; i < 40; i++) ws.send(`спам ${i}`);
    });
    expect(await closed).toBe(1008);
  });

  it("код закрытия 4401 («нужно войти») доходит до браузера как есть", async () => {
    const socket = await openSocket(`${h.wsUrl}/ws`);
    socket.ws.send("close4401");
    expect(await socket.closed).toBe(4401);
  });

  it("обрыв у бэкенда закрывает соединение с браузером кодом 1011", async () => {
    const socket = await openSocket(`${h.wsUrl}/ws`);
    socket.ws.send("drop");
    expect(await socket.closed).toBe(1011);
  });

  it("обычное закрытие бэкендом (1000) тоже доходит", async () => {
    const socket = await openSocket(`${h.wsUrl}/ws`);
    socket.ws.send("close1000");
    expect(await socket.closed).toBe(1000);
  });

  it("закрытие вкладки закрывает и соединение с бэкендом", async () => {
    const socket = await openSocket(`${h.wsUrl}/ws`);
    socket.ws.send("привет");
    await socket.next();
    const record = lastRecord();
    socket.close();
    await socket.closed;
    for (let i = 0; i < 50 && !record.closed; i++) await sleep(20);
    expect(record.closed).toBe(true);
  });

  it("бэкенд отклонил рукопожатие (например, не принял Origin) → соединение закрывается, без зависания", async () => {
    h.backend.mode = "ws-reject";
    const socket = await openSocket(`${h.wsUrl}/ws`);
    expect(await socket.closed).toBe(1011);
  });

  it("бэкенд недоступен → закрытие кодом 1011", async () => {
    const own = await createHarness();
    await own.backend.close();
    try {
      const socket = await openSocket(`${own.wsUrl}/ws`);
      expect(await socket.closed).toBe(1011);
    } finally {
      await own.app.close();
    }
  });

  it("слишком большое сообщение разрывает соединение", async () => {
    const socket = await openSocket(`${h.wsUrl}/ws`);
    socket.ws.send("x".repeat(70_000));
    expect([1006, 1009]).toContain(await socket.closed);
  });

  it("открытия WebSocket с одного адреса ограничены по частоте", async () => {
    const own = await createHarness({ RATE_LIMIT_WS_PER_MIN: "3" });
    try {
      for (let i = 0; i < 3; i++) (await openSocket(`${own.wsUrl}/ws`)).close();
      await expect(openSocket(`${own.wsUrl}/ws`)).rejects.toThrow("HTTP 429");
    } finally {
      await own.close();
    }
  });

  it("много соединений одновременно: ответы не смешиваются", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        const socket = await openSocket(`${h.wsUrl}/ws`);
        socket.ws.send(`клиент ${index}`);
        const reply = await socket.next();
        socket.close();
        return { index, reply };
      }),
    );
    for (const { index, reply } of results) expect(reply).toBe(`эхо:клиент ${index}`);
  });
});
