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

/**
 * Заглушка вместо Claude: нужна для локальной разработки и тестов без ключа и без расходов.
 * Повторяет поведение SDK: итоги по сессии накопительные, а после перезапуска процесса (его память
 * теряется) начинаются заново - как у SDK, когда в транскрипте не нашлось сохранённых итогов.
 * Управляющие слова в сообщении: [[fail]] - ошибка, [[slow]] - долгий ответ,
 * [[expensive]] - дорогой ход ($1.5), [[bash]] - вызов инструмента (только если инструменты разрешены).
 */
export class FakeAgentRunner implements AgentRunner {
  private totals = new Map<string, Snapshot>();

  /** Имитирует перезапуск процесса: накопленные итоги сессий забываются. */
  forgetTotals(): void {
    this.totals = new Map();
  }

  async *run(input: AgentTurnInput): AsyncGenerator<AgentEvent> {
    const { prompt, signal, policy } = input;
    const sessionId = input.sdkSessionId ?? `fake-${randomUUID()}`;
    yield { kind: "session", sessionId };

    if (prompt.includes("[[fail]]")) throw new Error("Симулированный сбой агента (ключ sk-ant-api03-ABCDEFGHIJKLMNOP)");
    if (prompt.includes("[[slow]]")) await pause(1500, signal);

    if (prompt.includes("[[bash]]") && policy.tools.includes("Bash")) {
      yield { kind: "tool", name: "Bash", summary: "echo hello" };
    }

    const reply = `Эхо: ${prompt}`;
    for (let i = 0; i < reply.length; i += 6) {
      await pause(2, signal);
      yield { kind: "delta", text: reply.slice(i, i + 6) };
    }
    yield { kind: "text", text: reply };

    const cost = prompt.includes("[[expensive]]") ? 1.5 : 0.01;
    const exceeded = input.maxBudgetUsd !== undefined && cost > input.maxBudgetUsd;
    const previous = this.totals.get(sessionId)?.[MODEL];
    const next = {
      inputTokens: (previous?.inputTokens ?? 0) + prompt.length,
      outputTokens: (previous?.outputTokens ?? 0) + reply.length,
      cacheReadInputTokens: previous?.cacheReadInputTokens ?? 0,
      cacheCreationInputTokens: previous?.cacheCreationInputTokens ?? 0,
      costUSD: Math.round(((previous?.costUSD ?? 0) + cost) * 1e8) / 1e8,
    };
    const modelUsage: Snapshot = { [MODEL]: next };
    this.totals.set(sessionId, modelUsage);

    yield {
      kind: "result",
      ok: !exceeded,
      subtype: exceeded ? "error_max_budget_usd" : "success",
      sessionId,
      totalCostUsd: next.costUSD,
      modelUsage,
      callTokens: prompt.length + reply.length,
      errorMessage: exceeded ? "budget" : undefined,
    };
  }
}
