import type Anthropic from "@anthropic-ai/sdk";
import { redactSecrets } from "../errors.js";
import type { Snapshot } from "../usage/ledger.js";
import { costOf } from "../usage/pricing.js";
import { summarizeTool } from "./summary.js";
import type { AgentEvent, AgentRunner, AgentTurnInput } from "./types.js";

type Sessions = Anthropic["beta"]["sessions"];
type StreamEvent = Anthropic.Beta.Sessions.BetaManagedAgentsStreamSessionEvents;
type ListedEvent = Anthropic.Beta.Sessions.BetaManagedAgentsSessionEvent;
type AnyEvent = StreamEvent | ListedEvent;

/** Часть клиента Anthropic, которая нужна раннеру песочницы (тесты подставляют заглушку, настоящий клиент подходит как есть). */
export interface ManagedClient {
  beta: {
    sessions: Pick<Sessions, "create" | "retrieve" | "update" | "delete"> & {
      events: Pick<Sessions["events"], "send" | "stream" | "list">;
    };
  };
}

export interface ManagedOptions {
  agentId: string;
  environmentId: string;
  /** Потолок стоимости хода, если вызывающий его не задал, USD. */
  defaultCapUsd?: number;
  /** Пауза между опросами сессии, когда поток событий оборвался, мс. */
  pollMs?: number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Стоимость работы контейнера по прейскуранту Anthropic: долларов в час. Нужна только если API не прислал готовую сумму. */
const RUNTIME_USD_PER_HOUR = 0.08;

const centsOf = (amount: string | null | undefined): number => {
  const cents = Number(amount);
  return Number.isFinite(cents) && cents > 0 ? Math.round(cents) : 0;
};
const capCentsOf = (usd: number) => Math.max(1, Math.ceil(usd * 100 - 1e-9));
const tokensOf = (value: number | undefined) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error("aborted"));
      },
      { once: true },
    );
  });
}

const isNotFound = (error: unknown) => (error as { status?: unknown } | null)?.status === 404;

interface TurnState {
  /** Мы увидели начало своего хода (эхо сообщения или переход в running): более ранние idle относятся не к нам. */
  started: boolean;
  done: boolean;
  terminated: boolean;
  stop?: string;
  errors: string[];
  seen: Set<string>;
  /** События, которые ждут подтверждения (мы не подтверждаем ничего вручную - отклоняем). */
  confirmations: string[];
}

/** Описание ошибки сессии для логов: без секретов и без лишнего. */
function describeSessionError(error: unknown): string {
  const data = error as { type?: unknown; message?: unknown } | null;
  const text = [data?.type, data?.message].filter((part): part is string => typeof part === "string").join(": ");
  return redactSecrets(text || "session error").slice(0, 300);
}

/**
 * Терминал для публичных подписчиков: агент работает в изолированной песочнице Anthropic (Managed Agents). Для каждого
 * диалога своя сессия и свой контейнер на стороне Anthropic; секретов ядра там нет, а сам агент настроен один раз
 * (scripts/sandbox-setup.ts). Расход берётся из учёта самой сессии (по прейскуранту Anthropic, вместе со временем контейнера).
 */
export class ManagedAgentRunner implements AgentRunner {
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly pollMs: number;

  constructor(
    private readonly client: ManagedClient,
    private readonly opts: ManagedOptions,
  ) {
    this.sleep = opts.sleep ?? pause;
    this.pollMs = opts.pollMs ?? 2000;
  }

  async forget(sessionId: string): Promise<void> {
    try {
      await this.client.beta.sessions.delete(sessionId);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  private async tryRetrieve(sessionId: string) {
    try {
      return await this.client.beta.sessions.retrieve(sessionId);
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async *run(input: AgentTurnInput): AsyncGenerator<AgentEvent> {
    const { signal } = input;
    const sessions = this.client.beta.sessions;
    const capCents = capCentsOf(input.maxBudgetUsd ?? this.opts.defaultCapUsd ?? 1);

    // 1. Сессия: берём прежнюю (с новым потолком на этот ход) либо заводим новую.
    let sessionId = input.sdkSessionId;
    if (sessionId) {
      const existing = await this.tryRetrieve(sessionId);
      if (!existing || existing.archived_at || existing.status === "terminated") {
        sessionId = undefined;
      } else {
        // Потолок сессии накопительный: к уже потраченному добавляем разрешённое на этот ход. Заодно это снимает паузу,
        // если прошлый ход остановился на бюджете.
        const consumed = centsOf(existing.usage?.list_cost?.amount);
        await sessions.update(
          sessionId,
          { budget: { type: "limit", max_list_cost: { amount: String(consumed + capCents), currency: "USD" } } },
          { signal },
        );
      }
    }
    if (!sessionId) {
      const created = await sessions.create(
        {
          agent: this.opts.agentId,
          environment_id: this.opts.environmentId,
          title: `entineq ${input.conversationId?.slice(0, 8) ?? ""}`.trim(),
          metadata: {
            app: "entineq",
            ...(input.userId ? { user: input.userId } : {}),
            ...(input.conversationId ? { conversation: input.conversationId } : {}),
          },
          budget: { type: "limit", max_list_cost: { amount: String(capCents), currency: "USD" } },
        },
        { signal },
      );
      sessionId = created.id;
      yield { kind: "session", sessionId };
    }

    // 2. Сначала открываем поток, потом отправляем сообщение: поток не показывает то, что случилось до его открытия.
    const state: TurnState = { started: false, done: false, terminated: false, errors: [], seen: new Set(), confirmations: [] };
    const startedAt = new Date(Date.now() - 60_000).toISOString();
    const stream = await sessions.events.stream(sessionId, { event_deltas: ["agent.message"] }, { signal });
    let sentId: string | undefined;
    let aborted = false;
    try {
      const sent = await sessions.events.send(
        sessionId,
        { events: [{ type: "user.message", content: [{ type: "text", text: input.prompt }] }] },
        { signal },
      );
      sentId = sent?.data?.[0]?.id;

      // 3. Читаем события хода до остановки агента.
      let broken = false;
      try {
        for await (const event of stream) {
          yield* this.handle(event, state);
          if (state.confirmations.length) await this.denyConfirmations(sessionId, state);
          if (state.done) break;
        }
      } catch (error) {
        if (signal.aborted) throw error;
        broken = true;
      }
      // Поток закрылся, а ход не закончен (обрыв связи): добираем события опросом.
      if (!state.done && (broken || !signal.aborted)) yield* this.recover(sessionId, state, sentId, startedAt, signal);
    } catch (error) {
      if (!signal.aborted) throw error;
      aborted = true;
    } finally {
      (stream as { controller?: AbortController } | undefined)?.controller?.abort();
    }

    // Ход прерван по таймауту: просим агента остановиться, чтобы он не тратил деньги дальше (ответ уже не нужен).
    if (aborted) await this.interrupt(sessionId);

    // 4. Итог: нарастающие итоги сессии (токены и стоимость по прейскуранту Anthropic).
    const final = await this.tryRetrieve(sessionId).catch(() => null);
    const failedText = state.errors.join("; ");
    const stop = state.stop;
    let subtype: string;
    let errorMessage: string | undefined;
    if (aborted) {
      subtype = "aborted";
      errorMessage = "turn aborted";
    } else if (state.terminated) {
      subtype = "terminated";
      errorMessage = failedText || "session terminated";
    } else if (stop === "end_turn") {
      subtype = "success";
    } else if (stop === "budget_reached") {
      subtype = "error_max_budget_usd";
      errorMessage = "budget reached";
    } else if (stop === "refusal") {
      subtype = "refusal";
      errorMessage = "refusal";
    } else {
      subtype = "error_during_execution";
      errorMessage = failedText || (stop ? `stopped: ${stop}` : "no stop reason");
    }

    let modelUsage: Snapshot = {};
    let totalCostUsd = 0;
    if (final) {
      const usage = final.usage ?? {};
      const model = final.agent?.model?.id ?? "managed-agent";
      const tokens = {
        inputTokens: tokensOf(usage.input_tokens),
        outputTokens: tokensOf(usage.output_tokens),
        cacheReadInputTokens: tokensOf(usage.cache_read_input_tokens),
        cacheCreationInputTokens: tokensOf(usage.cache_creation?.ephemeral_5m_input_tokens) + tokensOf(usage.cache_creation?.ephemeral_1h_input_tokens),
      };
      totalCostUsd = usage.list_cost
        ? centsOf(usage.list_cost.amount) / 100
        : Math.round((costOf(model, tokens) + (tokensOf(usage.active_seconds) * RUNTIME_USD_PER_HOUR) / 3600) * 1e8) / 1e8;
      modelUsage = { [model]: { ...tokens, costUSD: totalCostUsd } };
    }
    yield {
      kind: "result",
      ok: subtype === "success",
      subtype,
      sessionId,
      totalCostUsd,
      modelUsage,
      usageMode: "cumulative",
      errorMessage: errorMessage ? redactSecrets(errorMessage).slice(0, 300) : undefined,
    };
  }

  /** Превращает одно событие сессии в события ENTINEQ и запоминает состояние хода. */
  private *handle(event: AnyEvent, state: TurnState): Generator<AgentEvent> {
    const id = "id" in event && typeof event.id === "string" ? event.id : undefined;
    // Бывают события без собственного id (предпросмотры): их не дедуплицируем. Остальные - один раз.
    if (id) {
      if (state.seen.has(id)) return;
      state.seen.add(id);
    }
    switch (event.type) {
      case "event_start":
        break;
      case "event_delta": {
        const text = event.delta?.content?.text;
        if (typeof text === "string" && text) yield { kind: "delta", text };
        break;
      }
      case "user.message":
      case "session.status_running":
      case "span.model_request_start":
        state.started = true;
        break;
      case "agent.message": {
        state.started = true;
        const text = event.content
          .map((block) => (block.type === "text" ? block.text : ""))
          .join("");
        if (text.trim()) yield { kind: "text", text };
        break;
      }
      case "agent.tool_use":
        state.started = true;
        yield { kind: "tool", name: event.name, summary: summarizeTool(event.name, event.input) };
        break;
      case "session.error":
        state.errors.push(describeSessionError(event.error));
        break;
      case "session.status_idle": {
        // Idle, пришедший до начала нашего хода, - следы прошлого хода: игнорируем.
        if (!state.started) break;
        const reason = event.stop_reason;
        if (reason.type === "requires_action") {
          // Агент ждёт подтверждения действия. Подтверждать вручную некому: отклоняем, и агент продолжит другим путём.
          state.confirmations.push(...reason.event_ids);
          break;
        }
        state.stop = reason.type;
        state.done = true;
        break;
      }
      case "session.status_terminated":
        state.terminated = true;
        state.done = true;
        break;
      default:
        break;
    }
  }

  private async denyConfirmations(sessionId: string, state: TurnState): Promise<void> {
    const ids = state.confirmations.splice(0);
    await this.client.beta.sessions.events.send(sessionId, {
      events: ids.map((toolUseId) => ({
        type: "user.tool_confirmation" as const,
        tool_use_id: toolUseId,
        result: "deny" as const,
        deny_message: "Подтверждение вручную здесь недоступно. Выбери другой путь.",
      })),
    });
  }

  /** Добирает события хода опросом, когда поток оборвался: SSE не повторяет пропущенное, а список событий хранит всё. */
  private async *recover(
    sessionId: string,
    state: TurnState,
    sentId: string | undefined,
    sinceIso: string,
    signal: AbortSignal,
  ): AsyncGenerator<AgentEvent> {
    // Мы уже отправили сообщение, поэтому всё, что идёт после него, относится к нашему ходу.
    state.started = true;
    while (!state.done) {
      await this.sleep(this.pollMs, signal);
      const events: ListedEvent[] = [];
      for await (const event of this.client.beta.sessions.events.list(sessionId, { order: "asc", "created_at[gte]": sinceIso })) {
        events.push(event);
      }
      let from = sentId ? events.findIndex((event) => event.id === sentId) : -1;
      // Своё сообщение не нашли по id: берём последнее сообщение пользователя (ходы одного диалога идут строго по очереди).
      for (let i = events.length - 1; from < 0 && i >= 0; i--) if (events[i]!.type === "user.message") from = i;
      for (const event of events.slice(from + 1)) {
        yield* this.handle(event, state);
        if (state.done) break;
      }
      if (state.confirmations.length) await this.denyConfirmations(sessionId, state);
      if (!state.done) {
        const session = await this.tryRetrieve(sessionId);
        if (!session || session.status === "terminated") {
          state.terminated = true;
          state.done = true;
        }
      }
    }
  }

  private async interrupt(sessionId: string): Promise<void> {
    try {
      await this.client.beta.sessions.events.send(sessionId, { events: [{ type: "user.interrupt" }] });
    } catch {
      // Остановить не вышло: ход всё равно ограничен бюджетом сессии.
    }
  }
}
