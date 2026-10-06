import type { Snapshot } from "../usage/ledger.js";
import type { AgentPolicy } from "./policy.js";

export interface AgentTurnInput {
  prompt: string;
  /** Идентификатор сессии SDK из прошлых ходов диалога — по нему продолжается контекст. */
  sdkSessionId?: string;
  policy: AgentPolicy;
  /** Потолок стоимости одного хода, USD. */
  maxBudgetUsd?: number;
  signal: AbortSignal;
}

/** События, одинаковые для настоящего SDK и для заглушки. */
export type AgentEvent =
  | { kind: "session"; sessionId: string }
  /** Кусочек ответа в процессе генерации. Заменяется итоговым `text`. */
  | { kind: "delta"; text: string }
  /** Готовый фрагмент ответа. */
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string; summary: string }
  | {
      kind: "result";
      ok: boolean;
      /** success или подтип ошибки SDK: error_max_turns, error_max_budget_usd, error_during_execution. */
      subtype: string;
      sessionId?: string;
      totalCostUsd: number;
      /** Итоги по моделям (см. usage/ledger.ts): накопительные при продолжении сессии либо начатые заново. */
      modelUsage: Snapshot;
      /** Токены именно этого вызова (основной цикл): по ним учёт определяет, накопительные ли итоги. */
      callTokens?: number;
      errorMessage?: string;
    };

export interface AgentRunner {
  run(input: AgentTurnInput): AsyncIterable<AgentEvent>;
}
