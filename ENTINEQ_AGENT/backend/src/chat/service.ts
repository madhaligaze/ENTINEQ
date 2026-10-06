import { and, asc, desc, eq } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { policyFor } from "../agent/policy.js";
import type { AgentEvent, AgentRunner } from "../agent/types.js";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { conversations, messages, users } from "../db/schema.js";
import { AppError, errors, redactSecrets } from "../errors.js";
import type { Actor } from "../types.js";
import {
  blockReason,
  getLimitStatus,
  openWindow,
  recordTurnUsage,
  turnBudgetUsd,
  usageDto,
  type UsageDto,
} from "../usage/ledger.js";

/** События, которые сервер отправляет интерфейсу. */
export type ServerEvent =
  | { kind: "conversation"; id: string; title: string; isNew: boolean }
  | { kind: "delta"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; summary: string }
  | { kind: "usage"; usage: UsageDto }
  | { kind: "error"; code: string; message: string; resetsAt?: string }
  | { kind: "done" };

type ResultEvent = Extract<AgentEvent, { kind: "result" }>;

export interface TurnInput {
  text: string;
  conversationId?: string;
}

export interface ChatDeps {
  db: Db;
  runner: AgentRunner;
  cfg: Config;
  log: Pick<FastifyBaseLogger, "error" | "warn" | "info">;
  now?: () => Date;
}

export const makeTitle = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
};

export class ChatService {
  private readonly busyUsers = new Set<string>();
  private active = 0;
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(private readonly deps: ChatDeps) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  /** Выполняет один ход диалога. Завершается даже если сокет клиента уже закрыт — расходы всё равно учитываются. */
  runTurn(actor: Actor, input: TurnInput, emit: (event: ServerEvent) => void): Promise<void> {
    const run = this.execute(actor, input, emit);
    const tracked = run.then(
      () => undefined,
      () => undefined,
    );
    this.inflight.add(tracked);
    void tracked.then(() => this.inflight.delete(tracked));
    return run;
  }

  /** Ждёт завершения текущих ходов (нужно при остановке сервера). */
  async drain(timeoutMs: number): Promise<void> {
    await Promise.race([
      Promise.all([...this.inflight]),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]);
  }

  private async execute(actor: Actor, input: TurnInput, emit: (event: ServerEvent) => void): Promise<void> {
    // Обе проверки синхронные и идут до первого await — между ними никто не успеет вклиниться.
    if (this.busyUsers.has(actor.userId)) {
      throw new AppError("busy", "Предыдущий запрос ещё выполняется. Дождитесь ответа.", 409);
    }
    if (this.active >= this.deps.cfg.maxConcurrentTurns) {
      throw new AppError("server_busy", "Сервис сейчас загружен. Попробуйте через минуту.", 503);
    }
    this.busyUsers.add(actor.userId);
    this.active++;
    try {
      await this.executeLocked(actor, input, emit);
    } finally {
      this.busyUsers.delete(actor.userId);
      this.active--;
    }
  }

  private async executeLocked(actor: Actor, input: TurnInput, emit: (event: ServerEvent) => void): Promise<void> {
    const { db, runner, cfg, log } = this.deps;
    const windowHours = cfg.sessionWindowHours;

    const [user] = await db.select().from(users).where(eq(users.id, actor.userId)).limit(1);
    if (!user || !user.isActive) throw errors.unauthorized();

    // 1. Лимиты: если исчерпаны — не запускаем агента и не открываем окно.
    const now = this.now();
    const block = blockReason(await getLimitStatus(db, user, windowHours, now), now);
    if (block) {
      throw new AppError(block.code, block.message, block.code === "session_limit" ? 429 : 402, block.resetsAt?.toISOString());
    }

    // 2. Диалог: существующий (только свой) либо новый.
    let conversation: typeof conversations.$inferSelect;
    if (input.conversationId) {
      const [found] = await db
        .select()
        .from(conversations)
        .where(and(eq(conversations.id, input.conversationId), eq(conversations.userId, actor.userId)))
        .limit(1);
      if (!found) throw errors.notFound("Диалог не найден.");
      conversation = found;
    } else {
      const [created] = await db
        .insert(conversations)
        .values({ userId: actor.userId, entry: actor.entry, title: makeTitle(input.text) })
        .returning();
      conversation = created!;
    }
    emit({ kind: "conversation", id: conversation.id, title: conversation.title, isNew: !input.conversationId });

    // 3. Окно сессии открывается первым сообщением и дальше идёт по часам.
    const windowStart = await openWindow(db, user.id, windowHours, now);
    const statusNow = await getLimitStatus(db, { ...user, windowStartedAt: windowStart }, windowHours, now);
    const maxBudgetUsd = Math.min(turnBudgetUsd(statusNow) ?? Infinity, cfg.turnMaxBudgetUsd);

    await db.insert(messages).values({ conversationId: conversation.id, role: "user", content: input.text });

    // 4. Сам ход агента.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("turn timeout"));
    }, cfg.turnTimeoutMs);

    let result: ResultEvent | undefined;
    let failure: unknown;
    let storedSession = conversation.sdkSessionId;
    let sessionChanged = false;
    try {
      for await (const event of runner.run({
        prompt: input.text,
        sdkSessionId: conversation.sdkSessionId ?? undefined,
        policy: policyFor(actor, cfg),
        maxBudgetUsd,
        signal: controller.signal,
      })) {
        switch (event.kind) {
          case "session":
            if (event.sessionId !== storedSession) {
              // Сессия сменилась: прошлые накопительные итоги к новой не относятся.
              sessionChanged = storedSession !== null;
              storedSession = event.sessionId;
              await db.update(conversations).set({ sdkSessionId: event.sessionId }).where(eq(conversations.id, conversation.id));
            }
            break;
          case "delta":
            emit(event);
            break;
          case "text":
            await db.insert(messages).values({ conversationId: conversation.id, role: "assistant", content: event.text });
            emit(event);
            break;
          case "tool":
            await db
              .insert(messages)
              .values({ conversationId: conversation.id, role: "tool", content: `${event.name}: ${event.summary}` });
            emit(event);
            break;
          case "result":
            result = event;
            {
              const recorded = await recordTurnUsage(db, {
                userId: user.id,
                conversationId: conversation.id,
                outcome: event.subtype,
                next: event.modelUsage,
                sessionChanged,
                windowStart,
                at: this.now(),
                callTokens: event.callTokens,
              });
              // «restart» — SDK начал итоги заново (в транскрипте не было сохранённых): учтено целиком, но стоит знать об этом.
              if (recorded.mode === "restart") log.warn({ userId: user.id, conversationId: conversation.id }, "итоги SDK начались заново: расход хода учтён целиком");
              if (recorded.mode === "ignored") log.warn({ userId: user.id, subtype: event.subtype }, "SDK вернул нулевые итоги: расход хода не учтён");
            }
            break;
        }
      }
    } catch (error) {
      failure = error;
    } finally {
      clearTimeout(timer);
    }
    await db.update(conversations).set({ updatedAt: this.now() }).where(eq(conversations.id, conversation.id));

    // 5. Итог: актуальные лимиты и, если что-то пошло не так, понятная ошибка.
    const after = await getLimitStatus(db, { ...user, windowStartedAt: windowStart }, windowHours, this.now());
    emit({ kind: "usage", usage: usageDto(after) });

    const trusted = actor.entry === "direct";
    const generic = "Не удалось получить ответ. Попробуйте ещё раз.";
    if (timedOut) {
      emit({ kind: "error", code: "timeout", message: "Ответ занял слишком много времени и был остановлен." });
    } else if (failure) {
      log.error({ err: failure, userId: user.id }, "ошибка выполнения хода агента");
      const detail = failure instanceof Error ? redactSecrets(failure.message).slice(0, 300) : "";
      emit({ kind: "error", code: "agent_error", message: trusted && detail ? `${generic} (${detail})` : generic });
    } else if (!result) {
      emit({ kind: "error", code: "agent_error", message: generic });
    } else if (!result.ok) {
      if (result.subtype === "error_max_turns") {
        emit({ kind: "error", code: "agent_limit", message: "Агент достиг предела шагов для одного запроса. Разбейте задачу на части." });
      } else if (result.subtype === "error_max_budget_usd") {
        const limit = blockReason(after, this.now());
        emit({
          kind: "error",
          code: limit?.code ?? "budget_exceeded",
          message: limit?.message ?? "Запрос остановлен: достигнут лимит расходов.",
          resetsAt: limit?.resetsAt?.toISOString(),
        });
      } else {
        log.warn({ subtype: result.subtype, userId: user.id }, "агент завершился с ошибкой");
        const detail = result.errorMessage ? redactSecrets(result.errorMessage).slice(0, 300) : "";
        emit({ kind: "error", code: "agent_error", message: trusted && detail ? `${generic} (${detail})` : generic });
      }
    }
  }

  async usageFor(actor: Actor): Promise<UsageDto> {
    const { db, cfg } = this.deps;
    const [user] = await db.select().from(users).where(eq(users.id, actor.userId)).limit(1);
    if (!user) throw errors.unauthorized();
    return usageDto(await getLimitStatus(db, user, cfg.sessionWindowHours, this.now()));
  }

  async listConversations(actor: Actor) {
    const rows = await this.deps.db
      .select({ id: conversations.id, title: conversations.title, updatedAt: conversations.updatedAt })
      .from(conversations)
      .where(eq(conversations.userId, actor.userId))
      .orderBy(desc(conversations.updatedAt))
      .limit(100);
    return rows;
  }

  async messagesOf(actor: Actor, conversationId: string) {
    const { db } = this.deps;
    const [conversation] = await db
      .select({ id: conversations.id })
      .from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.userId, actor.userId)))
      .limit(1);
    if (!conversation) throw errors.notFound("Диалог не найден.");
    return db
      .select({ id: messages.id, role: messages.role, content: messages.content, createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.conversationId, conversationId))
      .orderBy(asc(messages.id))
      .limit(1000);
  }
}
