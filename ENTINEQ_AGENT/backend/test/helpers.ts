import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import pg from "pg";
import { WebSocket } from "ws";
import { FakeAgentRunner } from "../src/agent/fake-runner.js";
import { buildApp, type BuiltApp } from "../src/app.js";
import { PasswordHasher } from "../src/auth/password.js";
import { loadConfig, type Config } from "../src/config.js";
import { openDb, type Db, type DbHandle } from "../src/db/index.js";
import { SESSION_COOKIE } from "../src/routes/guards.js";

export const SECRET = "test-internal-secret-0123456789abcdef-0123456789";
export const OWNER = { email: "owner@example.com", password: "owner-password-123" };

/** Дешёвые параметры scrypt: тесты не должны ждать по 200 мс на каждый пароль. */
export const fastHasher = () => new PasswordHasher({ N: 2 ** 10, r: 8, p: 1 });

export function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "silent",
    INTERNAL_API_SECRET: SECRET,
    AGENT_RUNNER: "fake",
    DATA_DIR: "./.data/test",
    TRUST_PROXY_HOPS: "0",
    // В тестах входов и сокетов очень много с одного адреса: лимиты ослаблены, настоящие проверяются отдельным тестом.
    RATE_LIMIT_LOGIN_PER_MIN: "100000",
    RATE_LIMIT_WS_PER_MIN: "100000",
    ...overrides,
  });
}

/**
 * Настоящий Postgres (если задан TEST_DATABASE_URL — для каждого теста своя временная БД) либо встроенный PGlite.
 * Один и тот же набор тестов проходит на обоих.
 */
async function openTestDb(): Promise<{ handle: DbHandle; cleanup: () => Promise<void> }> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    const handle = await openDb({ pglite: "memory" });
    return { handle, cleanup: () => handle.close() };
  }
  const name = `t_${randomBytes(6).toString("hex")}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const handle = await openDb({ url: url.toString() });
  return {
    handle,
    cleanup: async () => {
      await handle.close();
      const dropper = new pg.Client({ connectionString: adminUrl });
      await dropper.connect();
      await dropper.query(`drop database if exists ${name} with (force)`);
      await dropper.end();
    },
  };
}

export interface Harness extends BuiltApp {
  cfg: Config;
  handle: DbHandle;
  db: Db;
  runner: FakeAgentRunner;
  /** Управляемые часы: сдвигаем время, не дожидаясь пяти часов. */
  clock: { now: Date };
  baseUrl: string;
  wsUrl: string;
  close(): Promise<void>;
}

export async function createHarness(env: Record<string, string> = {}, tweak?: (cfg: Config) => void): Promise<Harness> {
  const { handle, cleanup } = await openTestDb();
  await handle.migrate();
  const cfg = testConfig(env);
  tweak?.(cfg);
  const clock = { now: new Date() };
  const runner = new FakeAgentRunner();
  const built = await buildApp({ cfg, db: handle.db, runner, hasher: fastHasher(), now: () => clock.now });
  await built.auth.bootstrapOwner(OWNER.email, OWNER.password);
  await built.app.listen({ host: "127.0.0.1", port: 0 });
  const port = (built.app.server.address() as AddressInfo).port;
  return {
    ...built,
    cfg,
    handle,
    db: handle.db,
    runner,
    clock,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    close: async () => {
      await built.app.close();
      await cleanup();
    },
  };
}

let counter = 0;
export const uniqueEmail = (prefix = "user") => `${prefix}${++counter}-${randomBytes(3).toString("hex")}@example.com`;

/** Создаёт пользователя и сразу возвращает значение cookie для прямого входа. */
export async function loginDirect(h: Harness, email: string, password: string): Promise<string> {
  const response = await h.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
  if (response.statusCode !== 200) throw new Error(`login failed: ${response.statusCode} ${response.body}`);
  const cookie = response.cookies.find((c) => c.name === SESSION_COOKIE);
  if (!cookie) throw new Error("нет cookie сессии");
  return cookie.value;
}

export const ownerCookie = (h: Harness) => loginDirect(h, OWNER.email, OWNER.password);

export const asCookie = (token: string) => ({ cookie: `${SESSION_COOKIE}=${token}` });

/** Создаёт доверенного пользователя через админ-API и возвращает его cookie. */
export async function makeTrusted(h: Harness, options: { monthly?: number | null; window?: number | null } = {}) {
  const owner = await ownerCookie(h);
  const email = uniqueEmail("trusted");
  const password = "trusted-password-123";
  const response = await h.app.inject({
    method: "POST",
    url: "/api/admin/users",
    headers: asCookie(owner),
    payload: {
      email,
      password,
      role: "trusted",
      ...(options.monthly !== undefined ? { monthlyBudgetUsd: options.monthly } : {}),
      ...(options.window !== undefined ? { windowLimitUsd: options.window } : {}),
    },
  });
  if (response.statusCode !== 201) throw new Error(`createUser failed: ${response.body}`);
  return { email, password, id: response.json().user.id as string, cookie: await loginDirect(h, email, password) };
}

/** Создаёт публичного пользователя через приглашение и возвращает его токен для внутренней двери. */
export async function makePublic(h: Harness, options: { monthly?: number | null; window?: number | null } = {}) {
  const owner = await ownerCookie(h);
  const invite = await h.app.inject({
    method: "POST",
    url: "/api/admin/invites",
    headers: asCookie(owner),
    payload: {
      count: 1,
      ...(options.monthly !== undefined ? { monthlyBudgetUsd: options.monthly } : {}),
      ...(options.window !== undefined ? { windowLimitUsd: options.window } : {}),
    },
  });
  const code = invite.json().invites[0].code as string;
  const email = uniqueEmail("public");
  const password = "public-password-123";
  const response = await h.app.inject({
    method: "POST",
    url: "/internal/auth/register",
    headers: internalHeaders(),
    payload: { email, password, inviteCode: code },
  });
  if (response.statusCode !== 201) throw new Error(`register failed: ${response.body}`);
  const body = response.json();
  return { email, password, id: body.user.id as string, token: body.token as string, code };
}

export const internalHeaders = (token?: string): Record<string, string> => ({
  authorization: `Bearer ${SECRET}`,
  ...(token ? { "x-user-token": token } : {}),
});

type Event = { kind: string; [key: string]: unknown };

export interface Socket {
  ws: WebSocket;
  events: Event[];
  /** Отправляет сообщение и ждёт завершения хода (событие done). */
  turn(payload: Record<string, unknown>): Promise<Event[]>;
  closed: Promise<number>;
  close(): void;
}

export function openSocket(url: string, headers: Record<string, string>): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const events: Event[] = [];
    let waiter: (() => void) | undefined;
    const closed = new Promise<number>((done) => ws.on("close", (code) => done(code)));
    ws.on("message", (data) => {
      const event = JSON.parse(data.toString()) as Event;
      events.push(event);
      if (event.kind === "done") waiter?.();
    });
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once("open", () =>
      resolve({
        ws,
        events,
        closed,
        close: () => ws.close(),
        turn(payload) {
          const start = events.length;
          return new Promise<Event[]>((done) => {
            waiter = () => done(events.slice(start));
            ws.send(JSON.stringify({ type: "user", ...payload }));
          });
        },
      }),
    );
  });
}

export const directSocket = (h: Harness, cookie: string, origin = h.baseUrl) =>
  openSocket(`${h.wsUrl}/ws`, { cookie: `${SESSION_COOKIE}=${cookie}`, origin });

export const internalSocket = (h: Harness, token: string, secret = SECRET) =>
  openSocket(`${h.wsUrl}/internal/ws`, { authorization: `Bearer ${secret}`, "x-user-token": token });

export const kinds = (events: Event[]) => events.map((event) => event.kind);
