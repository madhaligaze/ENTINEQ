import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import { WebSocket, type RawData } from "ws";
import type { Config } from "./config.js";

type Log = Pick<FastifyBaseLogger, "error" | "warn">;

const HEARTBEAT_MS = 25_000;
/** Сколько сообщений браузера ждут, пока устанавливается соединение с бэкендом. */
const MAX_QUEUED = 32;
const CLOSE_UPSTREAM = 1011;
const CLOSE_POLICY = 1008;

/** Заголовки браузера, которые передаются бэкенду при открытии WebSocket. Всё остальное отбрасывается. */
const FORWARDED = ["cookie", "origin", "user-agent", "accept-language"] as const;

/** Коды закрытия, которые можно отправить по сети (1005, 1006, 1015 - служебные, их отправлять нельзя). */
const isSendableCloseCode = (code: number) => (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1011) || (code >= 3000 && code <= 4999);

/**
 * Прокладка WebSocket «браузер ↔ бэкенд»: кадры пересылаются как есть в обе стороны.
 * Бэкенд сам проверяет вход и Origin, поэтому сюда передаются cookie и Origin браузера,
 * а настоящий IP и адрес сайта - заголовками X-Forwarded-*. Коды закрытия (например 4401 - «нужно войти»)
 * передаются без изменений, служебные заменяются на 1011.
 */
export function proxyWebSocket(client: WebSocket, req: FastifyRequest, cfg: Pick<Config, "backendWsUrl">, log: Log): void {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  headers["x-forwarded-for"] = req.ip;
  headers["x-forwarded-host"] = req.host;
  headers["x-forwarded-proto"] = req.protocol;

  const pending: { data: RawData; isBinary: boolean }[] = [];
  let upstreamOpen = false;
  let closed = false;
  let clientAlive = true;
  let upstreamAlive = true;

  // Адрес у бэкенда всегда один: что именно запросил браузер (строка запроса и прочее), до него не доходит.
  const upstream = new WebSocket(`${cfg.backendWsUrl}/ws`, {
    headers,
    handshakeTimeout: 10_000,
    maxPayload: 4 * 1024 * 1024,
  });

  const heartbeat = setInterval(() => {
    if (!clientAlive) return client.terminate();
    clientAlive = false;
    client.ping();
    if (upstreamOpen) {
      if (!upstreamAlive) return upstream.terminate();
      upstreamAlive = false;
      upstream.ping();
    }
  }, HEARTBEAT_MS);

  const finish = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try {
      if (upstream.readyState === WebSocket.OPEN) upstream.close(1000, "proxy closed");
      else upstream.terminate();
    } catch {
      // уже закрыт
    }
    if (client.readyState === WebSocket.OPEN || client.readyState === WebSocket.CONNECTING) client.close(isSendableCloseCode(code) ? code : CLOSE_UPSTREAM, reason);
  };

  client.on("pong", () => (clientAlive = true));
  client.on("message", (data, isBinary) => {
    if (closed) return;
    if (upstreamOpen) upstream.send(data, { binary: isBinary });
    else if (pending.length < MAX_QUEUED) pending.push({ data, isBinary });
    else finish(CLOSE_POLICY, "too many pending messages");
  });
  client.on("close", () => finish(1000, "client closed"));
  client.on("error", () => finish(1000, "client error"));

  upstream.on("open", () => {
    upstreamOpen = true;
    for (const { data, isBinary } of pending.splice(0)) upstream.send(data, { binary: isBinary });
  });
  upstream.on("pong", () => (upstreamAlive = true));
  upstream.on("message", (data, isBinary) => {
    if (!closed && client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary });
  });
  upstream.on("unexpected-response", (_request, response) => {
    log.error({ status: response.statusCode }, "бэкенд отклонил WebSocket (проверьте BACKEND_URL и ALLOWED_ORIGINS бэкенда)");
    response.resume();
    finish(CLOSE_UPSTREAM, "upstream rejected");
  });
  upstream.on("error", (error) => {
    if (!closed) log.warn({ err: error }, "ошибка WebSocket к бэкенду");
    finish(CLOSE_UPSTREAM, "upstream error");
  });
  upstream.on("close", (code) => finish(code, "upstream closed"));
}
