import type { AddressInfo } from "node:net";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import { buildApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface Recorded {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

export interface WsRecord {
  headers: Record<string, string | string[] | undefined>;
  url: string;
  received: { data: string; binary: boolean }[];
  closed: boolean;
}

export interface FakeBackend {
  url: string;
  calls: Recorded[];
  ws: WsRecord[];
  /** Задержка перед обработкой любого запроса (в том числе рукопожатия WebSocket). */
  delayMs: number;
  /** Что делать: ok — всё как обычно; unhealthy — /healthz отвечает 500; ws-reject — рукопожатие WebSocket отклоняется (403). */
  mode: "ok" | "unhealthy" | "ws-reject";
  close(): Promise<void>;
}

/** Поддельный бэкенд: отвечает и эхом возвращает то, что до него дошло. */
export async function startFakeBackend(): Promise<FakeBackend> {
  const app: FastifyInstance = Fastify({ logger: false });
  await app.register(websocket);
  const state: FakeBackend = { url: "", calls: [], ws: [], delayMs: 0, mode: "ok", close: async () => {} };

  app.addHook("onRequest", async (req, reply) => {
    state.calls.push({ method: req.method, url: req.url, headers: { ...req.headers } });
    if (state.delayMs) await sleep(state.delayMs);
    if (state.mode === "ws-reject" && req.url.startsWith("/ws")) return reply.code(403).send({ error: "no" });
    if (state.mode === "unhealthy" && req.url === "/healthz") return reply.code(500).send({ ok: false });
  });
  app.addHook("preHandler", async (req) => {
    state.calls[state.calls.length - 1]!.body = req.body;
  });

  app.get("/healthz", async () => ({ ok: true }));
  app.get("/api/me", async (req) => ({ url: req.url, headers: req.headers }));
  app.all("/api/echo", async (req) => ({ method: req.method, body: req.body ?? null, headers: req.headers }));
  app.post("/api/auth/login", async (_req, reply) => {
    reply.header("set-cookie", ["entineq_session=abc123; Path=/; HttpOnly; SameSite=Lax; Secure", "second=2; Path=/"]);
    return { ok: true };
  });
  app.post("/api/auth/register", async () => ({ ok: true }));
  app.post("/api/auth/logout", async (_req, reply) => reply.code(204).send());
  app.get("/api/status/:code", async (req, reply) => {
    const code = Number((req.params as { code: string }).code);
    return reply.code(code).send({ error: { code: `status_${code}`, message: `Ответ ${code}` } });
  });
  app.get("/api/slow", async () => {
    await sleep(1600);
    return { ok: true };
  });

  app.get("/ws", { websocket: true }, (socket, req) => {
    const record: WsRecord = { headers: { ...req.headers }, url: req.url, received: [], closed: false };
    state.ws.push(record);
    socket.on("close", () => (record.closed = true));
    socket.on("message", (data, isBinary) => {
      const text = isBinary ? "" : data.toString();
      record.received.push({ data: isBinary ? "<binary>" : text, binary: isBinary });
      if (text === "close4401") return socket.close(4401, "unauthorized");
      if (text === "close1000") return socket.close(1000, "bye");
      if (text === "drop") return socket.terminate();
      socket.send(isBinary ? data : `эхо:${text}`, { binary: isBinary });
    });
  });

  await app.listen({ host: "127.0.0.1", port: 0 });
  state.url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  state.close = () => app.close();
  return state;
}

export interface Harness {
  app: FastifyInstance;
  backend: FakeBackend;
  cfg: Config;
  baseUrl: string;
  wsUrl: string;
  close(): Promise<void>;
}

export function testConfig(backendUrl: string, overrides: Record<string, string> = {}): Config {
  return loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "silent",
    BACKEND_URL: backendUrl,
    TRUST_PROXY_HOPS: "0",
    // В тестах запросов много с одного адреса: лимиты ослаблены, настоящие проверяются отдельными тестами.
    RATE_LIMIT_AUTH_PER_MIN: "100000",
    RATE_LIMIT_WS_PER_MIN: "100000",
    ...overrides,
  });
}

export async function createHarness(env: Record<string, string> = {}): Promise<Harness> {
  const backend = await startFakeBackend();
  const cfg = testConfig(backend.url, env);
  const app = await buildApp(cfg);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as AddressInfo).port;
  return {
    app,
    backend,
    cfg,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}`,
    close: async () => {
      await app.close();
      await backend.close().catch(() => undefined);
    },
  };
}

export async function call(h: Harness, method: string, path: string, options: { body?: unknown; rawBody?: string; headers?: Record<string, string> } = {}) {
  const hasJson = options.body !== undefined;
  const response = await fetch(`${h.baseUrl}${path}`, {
    method,
    headers: { ...(hasJson ? { "content-type": "application/json" } : {}), ...options.headers },
    body: options.rawBody ?? (hasJson ? JSON.stringify(options.body) : undefined),
  });
  const text = await response.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, text, json, setCookies: response.headers.getSetCookie() };
}

export interface Socket {
  ws: WebSocket;
  messages: { data: string; binary: boolean }[];
  closed: Promise<number>;
  next(): Promise<string>;
  close(): void;
}

export function openSocket(url: string, headers: Record<string, string> = {}): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const messages: { data: string; binary: boolean }[] = [];
    const waiters: ((text: string) => void)[] = [];
    const closed = new Promise<number>((done) => ws.on("close", (code) => done(code)));
    ws.on("message", (data, isBinary) => {
      const text = isBinary ? "<binary>" : data.toString();
      // Сообщение достаётся либо ожидающему next(), либо складывается в очередь — но не туда и туда.
      const waiter = waiters.shift();
      if (waiter) waiter(text);
      else messages.push({ data: text, binary: isBinary });
    });
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.once("open", () =>
      resolve({
        ws,
        messages,
        closed,
        close: () => ws.close(),
        next: () => new Promise<string>((done) => (messages.length ? done(messages.shift()!.data) : waiters.push(done))),
      }),
    );
  });
}
