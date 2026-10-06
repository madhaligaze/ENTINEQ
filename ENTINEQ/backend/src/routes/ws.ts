import type { FastifyBaseLogger, FastifyInstance, FastifyRequest } from "fastify";
import { WebSocket } from "ws";
import type { Config } from "../config.js";
import { clientMessage } from "../contract.js";
import { assertSameOrigin, SESSION_COOKIE } from "../guards.js";

const HEARTBEAT_MS = 25_000;
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_UPSTREAM = 1011;

type Log = Pick<FastifyBaseLogger, "error" | "warn">;

/**
 * Прокладка между браузером и ядром: пересылает сообщения в обе стороны, добавляя секрет и токен пользователя.
 * Секрет и токен уходят только в заголовках к ядру; в браузер они не попадают.
 */
export function proxyChat(browser: WebSocket, req: FastifyRequest, cfg: Config, log: Log): void {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) {
    browser.close(CLOSE_UNAUTHORIZED, "unauthorized");
    return;
  }

  const pending: string[] = [];
  let upstream: WebSocket | undefined;
  let upstreamOpen = false;
  let closed = false;
  /** Сколько ходов сейчас выполняется у ядра: нужно, чтобы отказы не посылали лишний done посреди хода. */
  let turnsInFlight = 0;

  const sendBrowser = (event: Record<string, unknown>) => {
    if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify(event));
  };

  let browserAlive = true;
  let upstreamAlive = true;
  const heartbeat = setInterval(() => {
    if (!browserAlive) return browser.terminate();
    browserAlive = false;
    browser.ping();
    if (upstreamOpen && upstream) {
      if (!upstreamAlive) return upstream.terminate();
      upstreamAlive = false;
      upstream.ping();
    }
  }, HEARTBEAT_MS);
  browser.on("pong", () => (browserAlive = true));

  const finish = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try {
      upstream?.terminate();
    } catch {
      // уже закрыт
    }
    if (browser.readyState === WebSocket.OPEN || browser.readyState === WebSocket.CONNECTING) browser.close(code, reason);
  };

  const failToBrowser = (message: string) => {
    sendBrowser({ kind: "error", code: "upstream_unavailable", message });
    sendBrowser({ kind: "done" });
    finish(CLOSE_UPSTREAM, "upstream");
  };

  browser.on("message", (data) => {
    if (closed) return;
    let message;
    try {
      message = clientMessage.parse(JSON.parse(data.toString()));
    } catch (error) {
      const issue = (error as { issues?: { message: string }[] }).issues?.[0]?.message;
      sendBrowser({ kind: "error", code: "invalid_message", message: issue ?? "Некорректное сообщение." });
      if (turnsInFlight === 0) sendBrowser({ kind: "done" });
      return;
    }
    const frame = JSON.stringify(message);
    turnsInFlight += 1;
    if (upstreamOpen && upstream) upstream.send(frame);
    else pending.push(frame);
  });
  browser.on("close", () => finish(1000, "browser closed"));
  browser.on("error", () => finish(1000, "browser error"));

  // Соединение с ядром открываем сразу, а сообщения, пришедшие раньше времени, ждут в очереди.
  upstream = new WebSocket(cfg.agentWsUrl, {
    headers: { authorization: `Bearer ${cfg.internalApiSecret}`, "x-user-token": token },
    handshakeTimeout: 10_000,
    maxPayload: 4 * 1024 * 1024,
  });
  upstream.on("open", () => {
    upstreamOpen = true;
    for (const frame of pending.splice(0)) upstream!.send(frame);
  });
  upstream.on("pong", () => (upstreamAlive = true));
  upstream.on("message", (data, isBinary) => {
    if (isBinary || closed) return;
    const text = data.toString();
    try {
      if ((JSON.parse(text) as { kind?: string }).kind === "done") turnsInFlight = Math.max(0, turnsInFlight - 1);
    } catch {
      // Не JSON - пересылаем как есть.
    }
    if (browser.readyState === WebSocket.OPEN) browser.send(text);
  });
  upstream.on("unexpected-response", (_request, response) => {
    log.error({ status: response.statusCode }, "ядро отклонило WebSocket (проверьте INTERNAL_API_SECRET и AGENT_BASE_URL)");
    response.resume();
    failToBrowser("Сервис временно недоступен. Попробуйте чуть позже.");
  });
  upstream.on("error", (error) => {
    log.warn({ err: error }, "ошибка WebSocket к ядру");
    failToBrowser("Нет связи с сервером. Попробуйте чуть позже.");
  });
  upstream.on("close", (code) => {
    // 4401 - ядро сообщает, что сессия недействительна: передаём как есть, интерфейс покажет вход.
    finish(code === CLOSE_UNAUTHORIZED ? CLOSE_UNAUTHORIZED : CLOSE_UPSTREAM, code === CLOSE_UNAUTHORIZED ? "unauthorized" : "upstream closed");
  });
}

export async function registerWs(app: FastifyInstance, cfg: Config): Promise<void> {
  app.get(
    "/ws",
    {
      websocket: true,
      preValidation: async (req) => assertSameOrigin(req, cfg),
      config: { rateLimit: { max: cfg.rateLimits.wsPerMinute, timeWindow: "1 minute" } },
    },
    (socket, req) => proxyChat(socket, req, cfg, req.log),
  );
}
