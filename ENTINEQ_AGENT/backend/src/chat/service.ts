import { and, asc, desc, eq, inArray, lt } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { accessInfo, planOf, releaseFreeTurn, reserveFreeTurn, type Plan } from "../access.js";
import { policyFor } from "../agent/policy.js";
import type { AgentEvent, AgentRunner, ChatTurn } from "../agent/types.js";
import type { Config } from "../config.js";
import type { Db } from "../db/index.js";
import { conversations, messages, users } from "../db/schema.js";
import { AppError, errors, redactSecrets } from "../errors.js";
import { hashIpBucket } from "../net/ip.js";
import type { Actor, Engine } from "../types.js";
import {
  blockReason,
  emptyLimitStatus,
  getLimitStatus,
  openWindow,
  recordTurnUsage,
  turnBudgetUsd,
  usageDto,
  type UsageDto,
} from "../usage/ledger.js";

/** События, которые сервер отправляет интерфейсу. */
export type ServerEvent =
  | { kind: "conversation"; id: string; title: string; isNew: boolean; engine: Engine }
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
  /** Только для нового диалога: terminal - вести его в песочнице (по подписке), chat или не задано - обычный чат. */
  mode?: "chat" | "terminal";
}

/** Что известно о запросе помимо самого сообщения. */
export interface TurnMeta {
  /** HMAC адреса посетителя (см. net/ip.ts): по нему считается суточный предел бесплатных запросов. */
  ipHash?: string;
}

export type Runners = Record<Engine, AgentRunner | null>;

export interface ChatDeps {
  db: Db;
  runners: Runners;
  cfg: Config;
  log: Pick<FastifyBaseLogger, "error" | "warn" | "info">;
  now?: () => Date;
}

export const makeTitle = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
};

type ConversationRow = typeof conversations.$inferSelect;

const GENERIC_FAILURE = "Не удалось получить ответ. Попробуйте ещё раз.";

export class ChatService {
  private readonly busyUsers = new Set<string>();
  private readonly active: Record<Engine, number> = { agent: 0, chat: 0, managed: 0 };
  private readonly inflight = new Set<Promise<unknown>>();

  constructor(private readonly deps: ChatDeps) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  private limitOf(engine: Engine): number {
    const { cfg } = this.deps;
    return engine === "agent" ? cfg.maxConcurrentTurns : engine === "chat" ? cfg.maxConcurrentChatTurns : cfg.sandbox.maxConcurrentTurns;
  }

  /** Выполняет один ход диалога. Завершается даже если сокет клиента уже закрыт - расходы всё равно учитываются. */
  runTurn(actor: Actor, input: TurnInput, emit: (event: ServerEvent) => void, meta: TurnMeta = {}): Promise<void> {
    const run = this.execute(actor, input, emit, meta);
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

  private async execute(actor: Actor, input: TurnInput, emit: (event: ServerEvent) => void, meta: TurnMeta): Promise<void> {
    // Проверка занятости и её запись идут до первого await - между ними никто не успеет вклиниться.
    if (this.busyUsers.has(actor.userId)) {
      throw new AppError("busy", "Предыдущий запрос ещё выполняется. Дождитесь ответа.", 409);
    }
    this.busyUsers.add(actor.userId);
    // Объект, а не переменная: присваивание внутри замыкания компилятор иначе не отслеживает.
    const slot: { engine?: Engine } = {};
    try {
      await this.executeLocked(actor, input, emit, meta, (engine) => {
        // Общий предел одновременных ходов у каждого движка свой: процесс Agent SDK тяжёлый, обычный запрос к API - лёгкий.
        if (this.active[engine] >= this.limitOf(engine)) {
          throw new AppError("server_busy", "Сервис сейчас загружен. Попробуйте через минуту.", 503);
        }
        this.active[engine]++;
        slot.engine = engine;
      });
    } finally {
      this.busyUsers.delete(actor.userId);
      if (slot.engine) this.active[slot.engine]--;
    }
  }

  /** Каким движком вести диалог: определяют «дверь» и подписка, а не клиент. */
  private resolveEngine(actor: Actor, plan: Plan, input: TurnInput, existing: ConversationRow | undefined): Engine {
    const { cfg } = this.deps;
    if (actor.role !== "public") return "agent";

    const sandboxOn = cfg.sandbox.mode === "managed";
    const needTerminal = (message: string) => {
      if (!sandboxOn) throw new AppError("terminal_unavailable", "Терминал сейчас недоступен.", 400);
      if (plan !== "subscription") throw new AppError("subscription_required", message, 402);
    };

    if (existing) {
      // Старые диалоги публичных пользователей (до появления движка chat) вёл Agent SDK без инструментов: продолжаем их как чат.
      if (existing.engine !== "managed") return "chat";
      needTerminal("Терминал доступен по подписке. Оформите её, чтобы продолжить этот диалог.");
      return "managed";
    }
    if (input.mode === "terminal") {
      needTerminal("Терминал доступен по подписке.");
      return "managed";
    }
    return "chat";
  }

  /** Последние реплики диалога для движка chat: не больше заданного числа и объёма, всегда с самых свежих. */
  private async loadHistory(conversationId: string): Promise<ChatTurn[]> {
    const { db, cfg } = this.deps;
    const rows = await db
      .select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), inArray(messages.role, ["user", "assistant"])))
      .orderBy(desc(messages.id))
      .limit(cfg.publicHistoryMessages);
    const kept: ChatTurn[] = [];
    let total = 0;
    for (const row of rows) {
      total += row.content.length;
      if (total > cfg.publicHistoryChars && kept.length) break;
      kept.push({ role: row.role === "user" ? "user" : "assistant", content: row.content });
    }
    return kept.reverse();
  }

  private async executeLocked(
    actor: Actor,
    input: TurnInput,
    emit: (event: ServerEvent) => void,
    meta: TurnMeta,
    acquire: (engine: Engine) => void,
  ): Promise<void> {
    const { db, cfg, log } = this.deps;
    const windowHours = cfg.sessionWindowHours;

    const [user] = await db.select().from(users).where(eq(users.id, actor.userId)).limit(1);
    if (!user || !user.isActive) throw errors.unauthorized();
    const now = this.now();
    const plan = planOf(user, now);
    const free = plan === "free";

    // 1. Диалог: существующий (только свой) либо новый - от него зависит движок.
    let conversation: ConversationRow | undefined;
    if (input.conversationId) {
      const [found] = await db
        .select()
        .from(conversations)
        .where(and(eq(conversations.id, input.conversationId), eq(conversations.userId, actor.userId)))
        .limit(1);
      if (!found) throw errors.notFound("Диалог не найден.");
      conversation = found;
    }
    const engine = this.resolveEngine(actor, plan, input, conversation);
    const runner = this.deps.runners[engine];
    if (!runner) throw new AppError("terminal_unavailable", "Этот режим сейчас недоступен.", 400);
    acquire(engine);

    // 2. Лимиты. Бесплатный запрос занимается заранее и возвращается, если ответа не вышло. Остальным - окно и месяц.
    let freeTurnId: number | undefined;
    if (free) {
      freeTurnId = await reserveFreeTurn(db, cfg, {
        userId: user.id,
        ipHash: meta.ipHash ?? hashIpBucket(cfg.internalApiSecret, "unknown"),
        now,
        subscribedUntil: user.subscribedUntil,
      });
    } else {
      const block = blockReason(await getLimitStatus(db, user, windowHours, now), now);
      if (block) {
        throw new AppError(block.code, block.message, block.code === "session_limit" ? 429 : 402, block.resetsAt?.toISOString());
      }
    }

    // Отдаём ли пользователю ответ или записанный расход: если нет - бесплатный запрос вернётся.
    let consumed = false;
    let failure: unknown;
    let timedOut = false;
    let result: ResultEvent | undefined;
    let windowStart = now;
    try {
      // 3. Новый диалог, окно сессии, потолок стоимости хода.
      if (!conversation) {
        const [created] = await db
          .insert(conversations)
          .values({ userId: actor.userId, entry: actor.entry, title: makeTitle(input.text), engine })
          .returning();
        conversation = created!;
      }
      emit({ kind: "conversation", id: conversation.id, title: conversation.title, isNew: !input.conversationId, engine });

      let maxBudgetUsd: number;
      if (free) {
        maxBudgetUsd = Math.min(cfg.free.turnMaxBudgetUsd, cfg.turnMaxBudgetUsd);
      } else {
        // Окно открывается первым сообщением и дальше идёт по часам.
        windowStart = await openWindow(db, user.id, windowHours, now);
        const statusNow = await getLimitStatus(db, { ...user, windowStartedAt: windowStart }, windowHours, now);
        maxBudgetUsd = Math.min(turnBudgetUsd(statusNow) ?? Infinity, engine === "managed" ? cfg.sandbox.turnMaxBudgetUsd : cfg.turnMaxBudgetUsd);
      }

      // Память нужна только чату; читаем до того, как в историю попадёт новое сообщение.
      const history = engine === "chat" ? await this.loadHistory(conversation.id) : undefined;
      await db.insert(messages).values({ conversationId: conversation.id, role: "user", content: input.text });

      // 4. Сам ход.
      const controller = new AbortController();
      const timer = setTimeout(
        () => {
          timedOut = true;
          controller.abort(new Error("turn timeout"));
        },
        engine === "managed" ? cfg.sandbox.turnTimeoutMs : cfg.turnTimeoutMs,
      );

      let storedSession = conversation.sdkSessionId;
      let sessionChanged = false;
      try {
        for await (const event of runner.run({
          prompt: input.text,
          history,
          sdkSessionId: conversation.sdkSessionId ?? undefined,
          policy: policyFor(actor, cfg, engine),
          maxBudgetUsd,
          signal: controller.signal,
          userId: user.id,
          conversationId: conversation.id,
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
              consumed = true;
              await db.insert(messages).values({ conversationId: conversation.id, role: "assistant", content: event.text });
              emit(event);
              break;
            case "tool":
              await db
                .insert(messages)
                .values({ conversationId: conversation.id, role: "tool", content: `${event.name}: ${event.summary}` });
              emit(event);
              break;
            case "result": {
              result = event;
              const recorded = await recordTurnUsage(db, {
                userId: user.id,
                conversationId: conversation.id,
                outcome: event.subtype,
                next: event.modelUsage,
                sessionChanged,
                windowStart,
                at: this.now(),
                callTokens: event.callTokens,
                usageMode: event.usageMode ?? "cumulative",
                isFree: free,
              });
              if (recorded.deltaUsd > 0) consumed = true;
              // «restart» - SDK начал итоги заново (в транскрипте не было сохранённых): учтено целиком, но стоит знать об этом.
              if (recorded.mode === "restart") log.warn({ userId: user.id, conversationId: conversation.id }, "итоги SDK начались заново: расход хода учтён целиком");
              if (recorded.mode === "ignored") log.warn({ userId: user.id, subtype: event.subtype }, "движок вернул нулевые итоги: расход хода не учтён");
              break;
            }
          }
        }
      } catch (error) {
        failure = error;
      } finally {
        clearTimeout(timer);
      }
      await db.update(conversations).set({ updatedAt: this.now() }).where(eq(conversations.id, conversation.id));
    } catch (error) {
      // Сбой подготовки хода (БД и т.п.): ход не состоялся, бесплатный запрос вернётся ниже.
      failure = error;
      if (!conversation) throw error;
    } finally {
      if (freeTurnId !== undefined && !consumed) {
        await releaseFreeTurn(db, user.id, freeTurnId).catch((error) => log.error({ err: error, userId: user.id }, "не удалось вернуть бесплатный запрос"));
      }
    }

    // 5. Итог: актуальные права и лимиты и, если что-то пошло не так, понятная ошибка.
    const [fresh] = await db.select().from(users).where(eq(users.id, user.id)).limit(1);
    const current = fresh ?? user;
    const after = await getLimitStatus(db, { ...current, windowStartedAt: free ? current.windowStartedAt : windowStart }, windowHours, this.now());
    emit({ kind: "usage", usage: usageDto(after, accessInfo(current, cfg, this.now())) });

    const trusted = actor.entry === "direct";
    if (timedOut) {
      emit({ kind: "error", code: "timeout", message: "Ответ занял слишком много времени и был остановлен." });
    } else if (failure) {
      log.error({ err: failure, userId: user.id }, "ошибка выполнения хода агента");
      const detail = failure instanceof Error ? redactSecrets(failure.message).slice(0, 300) : "";
      emit({ kind: "error", code: "agent_error", message: trusted && detail ? `${GENERIC_FAILURE} (${detail})` : GENERIC_FAILURE });
    } else if (!result) {
      emit({ kind: "error", code: "agent_error", message: GENERIC_FAILURE });
    } else if (!result.ok) {
      if (result.subtype === "error_max_turns") {
        emit({ kind: "error", code: "agent_limit", message: "Агент достиг предела шагов для одного запроса. Разбейте задачу на части." });
      } else if (result.subtype === "error_max_budget_usd") {
        // Бесплатный запрос, ответ которого уже получен, ошибкой не считается: потолок стоимости - внутренняя мера.
        if (!(free && consumed)) {
          const limit = blockReason(after, this.now());
          emit({
            kind: "error",
            code: limit?.code ?? "budget_exceeded",
            message: limit?.message ?? "Запрос остановлен: достигнут лимит расходов.",
            resetsAt: limit?.resetsAt?.toISOString(),
          });
        }
      } else if (result.subtype === "refusal") {
        emit({ kind: "error", code: "refusal", message: "Claude не стал отвечать на этот запрос. Попробуйте переформулировать его." });
      } else {
        log.warn({ subtype: result.subtype, userId: user.id }, "агент завершился с ошибкой");
        const detail = result.errorMessage ? redactSecrets(result.errorMessage).slice(0, 300) : "";
        emit({ kind: "error", code: "agent_error", message: trusted && detail ? `${GENERIC_FAILURE} (${detail})` : GENERIC_FAILURE });
      }
    }
  }

  async usageFor(actor: Actor): Promise<UsageDto> {
    const { db, cfg } = this.deps;
    const [user] = await db.select().from(users).where(eq(users.id, actor.userId)).limit(1);
    if (!user) throw errors.unauthorized();
    const now = this.now();
    return usageDto(await getLimitStatus(db, user, cfg.sessionWindowHours, now), accessInfo(user, cfg, now));
  }

  /** Права и лимиты посетителя без аккаунта: он ещё ничего не спрашивал, бесплатная квота целая. */
  anonymousUsage(): UsageDto {
    const { cfg } = this.deps;
    const now = this.now();
    return usageDto(emptyLimitStatus(cfg.sessionWindowHours, now), accessInfo(null, cfg, now));
  }

  async listConversations(actor: Actor) {
    const rows = await this.deps.db
      .select({ id: conversations.id, title: conversations.title, engine: conversations.engine, updatedAt: conversations.updatedAt })
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

  /**
   * Освобождает сессии песочницы у диалогов, в которых давно не писали: за контейнеры платит владелец.
   * Сам диалог и его история остаются; следующее сообщение в таком диалоге начнёт новую песочницу.
   */
  async purgeSandboxSessions(): Promise<number> {
    const { db, cfg, log } = this.deps;
    const runner = this.deps.runners.managed;
    if (!runner?.forget) return 0;
    const cutoff = new Date(this.now().getTime() - cfg.sandbox.retentionDays * 86_400_000);
    const stale = await db
      .select({ id: conversations.id, sessionId: conversations.sdkSessionId })
      .from(conversations)
      .where(and(eq(conversations.engine, "managed"), lt(conversations.updatedAt, cutoff)))
      .limit(50);
    let released = 0;
    for (const row of stale) {
      if (!row.sessionId) continue;
      try {
        await runner.forget(row.sessionId);
        // Итоги прежней сессии к новой не относятся, поэтому сбрасываем и их.
        await db.update(conversations).set({ sdkSessionId: null, usageSnapshot: {} }).where(eq(conversations.id, row.id));
        released++;
      } catch (error) {
        log.warn({ err: error, conversationId: row.id }, "не удалось освободить сессию песочницы");
      }
    }
    return released;
  }
}
