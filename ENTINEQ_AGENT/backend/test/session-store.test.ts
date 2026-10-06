import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPgSessionStore, stripNul } from "../src/agent/session-store.js";
import { openDb, type DbHandle } from "../src/db/index.js";

let handle: DbHandle;
const store = () => createPgSessionStore(handle.db);

beforeAll(async () => {
  handle = await openDb({ pglite: "memory" });
  await handle.migrate();
});
afterAll(() => handle.close());

const key = (sessionId: string, subpath?: string) => ({ projectKey: "proj", sessionId, ...(subpath ? { subpath } : {}) });

describe("PgSessionStore (хранилище транскриптов Agent SDK)", () => {
  it("load возвращает null для неизвестной сессии", async () => {
    expect(await store().load(key("нет-такой"))).toBeNull();
  });

  it("append + load сохраняют записи в порядке добавления", async () => {
    const s = store();
    await s.append(key("a"), [{ type: "user", uuid: "1", text: "привет" }]);
    await s.append(key("a"), [{ type: "assistant", uuid: "2" }, { type: "summary" }]);
    const loaded = await s.load(key("a"));
    expect(loaded?.map((e) => e.type)).toEqual(["user", "assistant", "summary"]);
    expect(loaded?.[0]).toEqual({ type: "user", uuid: "1", text: "привет" });
  });

  it("повторная отправка записи с тем же uuid не создаёт дубликат", async () => {
    const s = store();
    await s.append(key("dup"), [{ type: "user", uuid: "u1" }]);
    await s.append(key("dup"), [{ type: "user", uuid: "u1" }, { type: "assistant", uuid: "u2" }]);
    expect((await s.load(key("dup")))?.map((e) => e.uuid)).toEqual(["u1", "u2"]);
  });

  it("записи без uuid добавляются всегда", async () => {
    const s = store();
    await s.append(key("nouuid"), [{ type: "title", title: "x" }]);
    await s.append(key("nouuid"), [{ type: "title", title: "x" }]);
    expect(await s.load(key("nouuid"))).toHaveLength(2);
  });

  it("основной транскрипт и субагенты хранятся раздельно", async () => {
    const s = store();
    await s.append(key("sub"), [{ type: "user", uuid: "m1" }]);
    await s.append(key("sub", "subagents/agent-1"), [{ type: "user", uuid: "s1" }]);
    expect(await s.load(key("sub"))).toHaveLength(1);
    expect(await s.load(key("sub", "subagents/agent-1"))).toHaveLength(1);
    expect(await s.listSubkeys!({ projectKey: "proj", sessionId: "sub" })).toEqual(["subagents/agent-1"]);
  });

  it("разные проекты не пересекаются", async () => {
    const s = store();
    await s.append({ projectKey: "p1", sessionId: "same" }, [{ type: "user", uuid: "x" }]);
    expect(await s.load({ projectKey: "p2", sessionId: "same" })).toBeNull();
  });

  it("listSessions отдаёт идентификаторы и время изменения в миллисекундах", async () => {
    const s = store();
    await s.append({ projectKey: "listing", sessionId: "l1" }, [{ type: "user", uuid: "a" }]);
    await s.append({ projectKey: "listing", sessionId: "l2" }, [{ type: "user", uuid: "b" }]);
    await s.append({ projectKey: "listing", sessionId: "l1" }, [{ type: "user", uuid: "c" }], );
    const sessions = await s.listSessions!("listing");
    expect(sessions.map((x) => x.sessionId).sort()).toEqual(["l1", "l2"]);
    for (const { mtime } of sessions) {
      expect(Number.isInteger(mtime)).toBe(true);
      expect(Math.abs(Date.now() - mtime)).toBeLessThan(60_000);
    }
  });

  it("delete основной сессии убирает и её субагентов; delete субагента — только его", async () => {
    const s = store();
    await s.append(key("del"), [{ type: "user", uuid: "d1" }]);
    await s.append(key("del", "subagents/a"), [{ type: "user", uuid: "d2" }]);
    await s.append(key("del", "subagents/b"), [{ type: "user", uuid: "d3" }]);
    await s.delete!(key("del", "subagents/a"));
    expect(await s.load(key("del", "subagents/a"))).toBeNull();
    expect(await s.load(key("del", "subagents/b"))).toHaveLength(1);
    await s.delete!(key("del"));
    expect(await s.load(key("del"))).toBeNull();
    expect(await s.load(key("del", "subagents/b"))).toBeNull();
  });

  it("большие пачки записываются целиком", async () => {
    const s = store();
    const entries = Array.from({ length: 1234 }, (_, i) => ({ type: "user", uuid: `bulk-${i}`, n: i }));
    await s.append(key("bulk"), entries);
    const loaded = await s.load(key("bulk"));
    expect(loaded).toHaveLength(1234);
    expect(loaded?.[0]?.n).toBe(0);
    expect(loaded?.[1233]?.n).toBe(1233);
  });

  it("символ NUL в тексте не ломает запись (Postgres не принимает его в JSONB)", async () => {
    const s = store();
    await s.append(key("nul"), [{ type: "user", uuid: "n1", text: "до\u0000после" }]);
    expect((await s.load(key("nul")))?.[0]?.text).toBe("допосле");
  });
});

describe("stripNul", () => {
  it("убирает настоящий NUL, но не трогает текст «\\u0000» как последовательность символов", () => {
    expect(stripNul({ type: "t", a: "x\u0000y" }).a).toBe("xy");
    const literal = { type: "t", a: "обратная косая и u0000: \\u0000" };
    expect(stripNul(literal)).toEqual(literal);
    expect(stripNul({ type: "t", nested: { arr: ["\u0000a", "b"] } })).toEqual({ type: "t", nested: { arr: ["a", "b"] } });
  });

  it("запись без NUL возвращается как есть", () => {
    const entry = { type: "t", a: "чисто" };
    expect(stripNul(entry)).toBe(entry);
  });
});
