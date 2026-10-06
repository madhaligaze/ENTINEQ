import { randomUUID } from "node:crypto";
import type { Snapshot } from "../usage/ledger.js";
import type { AgentEvent, AgentRunner, AgentTurnInput } from "./types.js";

const MODEL = "fake-model";

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

export interface FakeOptions {
  /**
   * cumulative - как Agent SDK и Managed Agents: у хода есть сессия, итоги нарастающие (по умолчанию);
   * delta - как Messages API: сессии нет, итоги только этого хода.
   */
  usage?: "cumulative" | "delta";
}

/**
 * Заглушка вместо Claude: нужна для локальной разработки и тестов без ключа и без расходов.
 * Повторяет поведение настоящих движков: итоги по сессии накопительные, а после перезапуска процесса (его память
 * теряется) начинаются заново - как у SDK, когда в транскрипте не нашлось сохранённых итогов.
 * Управляющие слова в сообщении: [[fail]] - ошибка, [[slow]] - долгий ответ, [[expensive]] - дорогой ход ($1.5),
 * [[bash]] - вызов инструмента (только если инструменты разрешены), [[history]] - в ответе число реплик истории.
 */
export class FakeAgentRunner implements AgentRunner {
  private totals = new Map<string, Snapshot>();
  /** Все запросы, которые получил раннер (для проверок в тестах). */
  readonly calls: AgentTurnInput[] = [];
  /** Сессии, освобождённые через forget: следующий ход с таким идентификатором получит новую сессию. */
  readonly forgotten = new Set<string>();

  constructor(private readonly options: FakeOptions = {}) {}

  /** Имитирует перезапуск процесса: накопленные итоги сессий забываются. */
  forgetTotals(): void {
    this.totals = new Map();
  }

  async forget(sessionId: string): Promise<void> {
    this.forgotten.add(sessionId);
  }

  async *run(input: AgentTurnInput): AsyncGenerator<AgentEvent> {
    this.calls.push(input);
    const { prompt, signal, policy } = input;
    const delta = this.options.usage === "delta";
    const alive = input.sdkSessionId && !this.forgotten.has(input.sdkSessionId) ? input.sdkSessionId : undefined;
    const sessionId = delta ? undefined : (alive ?? `fake-${randomUUID()}`);
    if (sessionId) yield { kind: "session", sessionId };

    if (prompt.includes("[[fail]]")) throw new Error("Симулированный сбой агента (ключ sk-ant-api03-ABCDEFGHIJKLMNOP)");
    if (prompt.includes("[[slow]]")) await pause(1500, signal);

    if (prompt.includes("[[bash]]") && policy.tools.includes("Bash")) {
      yield { kind: "tool", name: "Bash", summary: "echo hello" };
    }

    const reply = prompt.includes("[[history]]") ? `История: ${input.history?.length ?? 0}` : `Эхо: ${prompt}`;
    for (let i = 0; i < reply.length; i += 6) {
      await pause(2, signal);
      yield { kind: "delta", text: reply.slice(i, i + 6) };
    }
    yield { kind: "text", text: reply };

    const cost = prompt.includes("[[expensive]]") ? 1.5 : 0.01;
    const exceeded = input.maxBudgetUsd !== undefined && cost > input.maxBudgetUsd;
    const previous = sessionId ? this.totals.get(sessionId)?.[MODEL] : undefined;
    const next = {
      inputTokens: (previous?.inputTokens ?? 0) + prompt.length,
      outputTokens: (previous?.outputTokens ?? 0) + reply.length,
      cacheReadInputTokens: previous?.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: previous?.cacheCreationInputTokens ?? 0,
      costUSD: Math.round(((previous?.costUSD ?? 0) + cost) * 1e8) / 1e8,
    };
    const modelUsage: Snapshot = { [MODEL]: next };
    if (sessionId) this.totals.set(sessionId, modelUsage);

    yield {
      kind: "result",
      ok: !exceeded,
      subtype: exceeded ? "error_max_budget_usd" : "success",
      sessionId,
      totalCostUsd: next.costUSD,
      modelUsage,
      usageMode: delta ? "delta" : "cumulative",
      callTokens: prompt.length + reply.length,
      errorMessage: exceeded ? "budget" : undefined,
    };
  }
}
