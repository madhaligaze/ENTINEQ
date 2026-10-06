import type { WebSocket } from "ws";
import type { ServerEvent } from "../chat/service.js";
import { AppError } from "../errors.js";
import { clientMessage } from "../schemas.js";
import type { Actor } from "../types.js";
import type { AppContext } from "./context.js";

const HEARTBEAT_MS = 25_000;

/** Код закрытия WebSocket: интерфейс по нему понимает, что нужно снова войти. */
export const CLOSE_UNAUTHORIZED = 4401;

export function toErrorEvent(error: unknown, log: { error: (...args: unknown[]) => void }): ServerEvent {
  if (error instanceof AppError) {
    return { kind: "error", code: error.code, message: error.message, ...(error.resetsAt ? { resetsAt: error.resetsAt } : {}) };
  }
  log.error(error);
  return { kind: "error", code: "internal_error", message: "Внутренняя ошибка сервера." };
}

/**
 * Обслуживает один WebSocket-диалог. Личность проверяется заново на каждое сообщение:
 * выход из аккаунта и отключение пользователя действуют сразу, без разрыва соединения.
 */
export function serveChat(
  socket: WebSocket,
  ctx: AppContext,
  resolveActor: () => Promise<Actor | null>,
  log: { error: (...args: unknown[]) => void },
): void {
  let alive = true;
  socket.on("pong", () => {
    alive = true;
  });
  const heartbeat = setInterval(() => {
    if (!alive) {
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, HEARTBEAT_MS);
  socket.on("close", () => clearInterval(heartbeat));

  const send = (event: ServerEvent) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
  };

  let busy = false;
  const handle = async (raw: string) => {
    // Ответ «busy» без done: ход этого сокета ещё идёт и сам пришлёт done, когда закончится.
    if (busy) {
      send({ kind: "error", code: "busy", message: "Предыдущий запрос ещё выполняется. Дождитесь ответа." });
      return;
    }
    busy = true;
    let closeCode: number | undefined;
    try {
      let message: ReturnType<typeof clientMessage.parse>;
      try {
        message = clientMessage.parse(JSON.parse(raw));
      } catch (error) {
        const issue = (error as { issues?: { message: string }[] }).issues?.[0]?.message;
        send({ kind: "error", code: "invalid_message", message: issue ?? "Некорректное сообщение." });
        return;
      }
      const actor = await resolveActor();
      if (!actor) {
        send({ kind: "error", code: "unauthorized", message: "Сессия закончилась. Войдите снова." });
        closeCode = CLOSE_UNAUTHORIZED;
        return;
      }
      await ctx.chat.runTurn(actor, { text: message.text, conversationId: message.conversationId }, send);
    } catch (error) {
      send(toErrorEvent(error, log));
    } finally {
      busy = false;
      send({ kind: "done" });
      // Закрываем только после done: иначе интерфейс не узнает, что ход закончен.
      if (closeCode !== undefined) socket.close(closeCode, "unauthorized");
    }
  };

  socket.on("message", (data) => {
    void handle(data.toString());
  });
}
