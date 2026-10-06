import type { Snapshot } from "../usage/ledger.js";
import type { AgentPolicy } from "./policy.js";

/** Реплика диалога, которую движок chat получает вместе с новым сообщением (сам он ничего не помнит). */
export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface AgentTurnInput {
  prompt: string;
  /** Предыдущие реплики диалога. Нужны только движку chat: Agent SDK и песочница хранят контекст у себя. */
  history?: ChatTurn[];
  /** Идентификатор сессии движка из прошлых ходов диалога: Agent SDK - для resume, Managed Agents - сессия песочницы. */
  sdkSessionId?: string;
  policy: AgentPolicy;
  /** Потолок стоимости одного хода, USD. */
  maxBudgetUsd?: number;
  signal: AbortSignal;
  /** Для пометки запросов и сессий в консоли Anthropic. Идентификаторы непрозрачные: ни имён, ни почты. */
  userId?: string;
  conversationId?: string;
}

/** События, одинаковые для всех движков и для заглушки. */
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
      /** success или подтип ошибки: error_max_turns, error_max_budget_usd, error_during_execution, refusal, aborted. */
      subtype: string;
      sessionId?: string;
      totalCostUsd: number;
      /** Итоги по моделям (см. usage/ledger.ts). */
      modelUsage: Snapshot;
      /**
       * Как читать modelUsage: cumulative - нарастающие итоги сессии (Agent SDK, Managed Agents), расход хода - разница с прошлыми;
       * delta - итоги только этого хода (Messages API). По умолчанию cumulative.
       */
      usageMode?: "cumulative" | "delta";
      /** Токены именно этого вызова (основной цикл): по ним учёт определяет, накопительные ли итоги. */
      callTokens?: number;
      errorMessage?: string;
    };

export interface AgentRunner {
  run(input: AgentTurnInput): AsyncIterable<AgentEvent>;
  /** Освобождает сессию движка на его стороне (песочницу). Не обязательна: у остальных движков освобождать нечего. */
  forget?(sessionId: string): Promise<void>;
}
