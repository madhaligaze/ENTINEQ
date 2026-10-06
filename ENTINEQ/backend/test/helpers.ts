import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { buildApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";

export const SECRET = "test-internal-secret-0123456789abcdef-0123456789";

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export type Mode = "ok" | "secret-reject" | "http500" | "bad-contract" | "wrong-version" | "logout-fails" | "old-core";

export interface Call {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface FakeCore {
  url: string;
  mode: Mode;
  delayMs: number;
  calls: Call[];
  /** Заголовки рукопожатия и сообщения, которые получил /internal/ws. */
  ws: { headers: Record<string, string | string[] | undefined>; received: unknown[]; closed: boolean }[];
  close(): Promise<void>;
}

const usage = {
  month: "2026-10",
  monthSpentUsd: 0,
  monthBudgetUsd: 10,
  monthResetsAt: "2026-11-01T00:00:00.000Z",
  window: { hours: 5, active: false, startedAt: null, resetsAt: null, spentUsd: 0, limitUsd: 1 },
};

/** Поддельное ядро: отвечает так, как отвечает ENTINEQ_AGENT, и умеет ломаться по команде теста. */
export async function startFakeCore(): Promise<FakeCore> {
  const app = Fastify({ logger: false });
  await app.register(websocket);
  const tokens = new Map<string, { id: string; email: string }>();
  const state: FakeCore = { url: "", mode: "ok", delayMs: 0, calls: [], ws: [], close: async () => {} };

  app.addHook("onRequest", async (req, reply) => {
    state.calls.push({ method: req.method, path: req.url, headers: { ...req.headers } });
    if (state.mode === "secret-reject" || req.headers.authorization !== `Bearer ${SECRET}`) {
      return reply.code(401).send({ error: { code: "internal_unauthorized", message: "Нет доступа." } });
    }
    if (state.mode === "http500") return reply.code(500).send({ error: { code: "internal_error", message: "boom" } });
    if (state.delayMs) await sleep(state.delayMs);
  });
  app.addHook("preHandler", async (req) => {
    state.calls[state.calls.length - 1]!.body = req.body;
  });

  const userOf = (token: unknown) => (typeof token === "string" ? tokens.get(token) : undefined);
  const unauthorized = { error: { code: "unauthorized", message: "Нужно войти в аккаунт." } };
  const grant = (email: string) => {
    const token = randomBytes(24).toString("base64url");
    const user = { id: randomUUID(), email };
    tokens.set(token, user);
    return { token, expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(), user: { ...user, role: "public" }, usage };
  };

  app.get("/internal/ping", async (_req, reply) => {
    // «Старое ядро» ещё не знает маршрута /ping — отвечает так же, как неизвестный адрес.
    if (state.mode === "old-core") return reply.code(404).send({ error: { code: "not_found", message: "Не найдено." } });
    return state.mode === "bad-contract" ? { nope: true } : { ok: true, service: "entineq-agent", contract: state.mode === "wrong-version" ? 99 : 1 };
  });

  app.post("/internal/auth/register", async (req, reply) => {
    const body = req.body as { email: string; inviteCode: string };
    if (body.inviteCode === "ENT-BAD0-BAD0-BAD0") return reply.code(400).send({ error: { code: "invalid_invite", message: "Приглашение недействительно или уже использовано." } });
    if (body.email === "taken@example.com") return reply.code(409).send({ error: { code: "email_taken", message: "Этот email уже зарегистрирован." } });
    return reply.code(201).send(state.mode === "bad-contract" ? { token: "x" } : grant(body.email));
  });

  app.post("/internal/auth/login", async (req, reply) => {
    const body = req.body as { email: string; password: string };
    if (body.password === "wrong-password") return reply.code(401).send({ error: { code: "invalid_credentials", message: "Неверный email или пароль." } });
    if (body.password === "locked-password") return reply.code(423).send({ error: { code: "account_locked", message: "Слишком много неудачных попыток входа. Попробуйте через 10 минут." } });
    return grant(body.email);
  });

  app.post("/internal/auth/logout", async (req, reply) => {
    if (state.mode === "logout-fails") return reply.code(500).send({ error: { code: "internal_error", message: "x" } });
    tokens.delete(String(req.headers["x-user-token"]));
    return reply.code(204).send();
  });

  app.get("/internal/me", async (req, reply) => {
    const user = userOf(req.headers["x-user-token"]);
    if (!user) return reply.code(401).send(unauthorized);
    return state.mode === "bad-contract" ? { user: { id: 1 } } : { user: { ...user, role: "public" }, usage };
  });

  app.get("/internal/conversations", async (req, reply) => {
    if (!userOf(req.headers["x-user-token"])) return reply.code(401).send(unauthorized);
    return { conversations: [{ id: randomUUID(), title: "тест", updatedAt: new Date().toISOString() }] };
  });

  app.get("/internal/conversations/:id/messages", async (req, reply) => {
    if (!userOf(req.headers["x-user-token"])) return reply.code(401).send(unauthorized);
    const { id } = req.params as { id: string };
    if (id === "00000000-0000-4000-8000-000000000000") return reply.code(404).send({ error: { code: "not_found", message: "Диалог не найден." } });
    return { messages: [{ id: 1, role: "user", content: "привет", createdAt: new Date().toISOString() }] };
  });

  app.get("/internal/ws", { websocket: true }, (socket, req) => {
    const record = { headers: { ...req.headers }, received: [] as unknown[], closed: false };
    state.ws.push(record);
    socket.on("close", () => (record.closed = true));
    if (!userOf(req.headers["x-user-token"])) return socket.close(4401, "unauthorized");
    socket.on("message", async (data) => {
      const message = JSON.parse(data.toString()) as { text: string; conversationId?: string };
      record.received.push(message);
      const send = (event: object) => socket.send(JSON.stringify(event));
      if (message.text.includes("[[4401]]")) return socket.close(4401, "unauthorized");
      if (message.text.includes("[[drop]]")) return socket.terminate();
      if (message.text.includes("[[slow]]")) await sleep(600);
      send({ kind: "conversation", id: message.conversationId ?? randomUUID(), title: message.text.slice(0, 20), isNew: !message.conversationId });
      send({ kind: "delta", text: "Эхо" });
      send({ kind: "text", text: `Эхо: ${message.text}` });
      send({ kind: "usage", usage });
      send({ kind: "done" });
    });
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  state.url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  state.close = () => app.close();
  return state;
}

export interface Harness {
  app: FastifyInstance;
  core: FakeCore;
  cfg: Config;
  baseUrl: string;
  wsUrl: string;
  close(): Promise<void>;
}

export function testConfig(agentBaseUrl: string, overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "silent",
    AGENT_BASE_URL: agentBaseUrl,
    INTERNAL_API_SECRET: SECRET,
    TRUST_PROXY_HOPS: "0",
    // В тестах запросов очень много с одного адреса; настоящие лимиты проверяются отдельным тестом.
    RATE_LIMIT_AUTH_PER_MIN: "100000",
    RATE_LIMIT_WS_PER_MIN: "100000",
    ...overrides,
  });
}

export async function createHarness(env: Record<string, string> = {}): Promise<Harness> {
  const core = await startFakeCore();
  const cfg = testConfig(core.url, env);
  const { app } = await buildApp(cfg);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  return {
    app,
    core,
    cfg,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    close: async () => {
      await app.close();
      await core.close().catch(() => undefined);
    },
  };
}

export const SESSION_COOKIE = "entineq_session";

/** Разбирает Set-Cookie ответа fetch. */
export function cookiesOf(response: Response): Record<string, { value: string; attrs: string }> {
  const result: Record<string, { value: string; attrs: string }> = {};
  for (const line of response.headers.getSetCookie()) {
    const [pair, ...rest] = line.split(";");
    const [name, ...value] = pair!.split("=");
    result[name!.trim()] = { value: value.join("="), attrs: rest.join(";").toLowerCase() };
  }
  return result;
}

export async function call(h: Harness, method: string, path: string, options: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {}) {
  const response = await fetch(`${h.baseUrl}${path}`, {
    method,
    headers: {
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(options.cookie ? { cookie: `${SESSION_COOKIE}=${options.cookie}` } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text, response, cookies: cookiesOf(response) };
}

export async function register(h: Harness, email = `u${randomBytes(3).toString("hex")}@example.com`) {
  const result = await call(h, "POST", "/api/auth/register", { body: { email, password: "password-12345", inviteCode: "ENT-AAAA-BBBB-CCCC" } });
  if (result.status !== 201) throw new Error(`register failed: ${result.text}`);
  return { email, cookie: result.cookies[SESSION_COOKIE]!.value };
}

type Event = { kind: string; [key: string]: unknown };

export interface Socket {
  ws: WebSocket;
  events: Event[];
  closed: Promise<number>;
  turn(payload: Record<string, unknown>): Promise<Event[]>;
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

export const browserSocket = (h: Harness, cookie?: string, origin = h.baseUrl) =>
  openSocket(`${h.wsUrl}/ws`, { origin, ...(cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {}) });

export const kinds = (events: Event[]) => events.map((e) => e.kind);
