import type Anthropic from "@anthropic-ai/sdk";
import { redactSecrets } from "../errors.js";
import { costOf, estimateTokens, ratesFor } from "../usage/pricing.js";
import type { Snapshot } from "../usage/ledger.js";
import type { AgentEvent, AgentRunner, AgentTurnInput, ChatTurn } from "./types.js";

/** Часть клиента Anthropic, которая нужна чату (тесты подставляют свою заглушку, настоящий клиент подходит как есть). */
export interface ChatClient {
  messages: {
    stream(body: Anthropic.MessageStreamParams, options?: { signal?: AbortSignal }): AsyncIterable<Anthropic.MessageStreamEvent>;
  };
}

const TRUNCATED_NOTE = "\n\n[Ответ обрезан: достигнут предел длины одного ответа.]";
/** Меньше этого ответу не оставляем, даже если лимит почти исчерпан: иначе ответ обрывался бы на первом слове. */
const MIN_OUTPUT_TOKENS = 256;

const count = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0);

/** Склеивает соседние реплики одного автора (API принимает чередование, а при сбое хода в истории бывают два сообщения пользователя подряд). */
export function buildMessages(history: ChatTurn[], prompt: string): { role: "user" | "assistant"; content: string }[] {
  const merged: { role: "user" | "assistant"; content: string }[] = [];
  for (const turn of [...history, { role: "user" as const, content: prompt }]) {
    if (!turn.content.trim()) continue;
    const last = merged.at(-1);
    if (last && last.role === turn.role) last.content += `\n\n${turn.content}`;
    else merged.push({ role: turn.role, content: turn.content });
  }
  // Разговор должен начинаться с реплики пользователя.
  while (merged[0]?.role === "assistant") merged.shift();
  return merged;
}

/** Потолок длины ответа: сколько токенов можно потратить, не выйдя за бюджет хода (мысли модели входят в эту длину). */
export function outputCap(input: { budgetUsd?: number; inputRate: number; outputRate: number; inputEstimate: number; ceiling: number }): number {
  if (input.budgetUsd === undefined || !Number.isFinite(input.budgetUsd)) return input.ceiling;
  const inputCost = (input.inputEstimate * input.inputRate) / 1_000_000;
  const affordable = Math.floor(((input.budgetUsd - inputCost) * 1_000_000) / input.outputRate);
  return Math.max(MIN_OUTPUT_TOKENS, Math.min(input.ceiling, affordable));
}

/**
 * Публичный чат без инструментов: обычный запрос к Messages API, без процесса агента.
 * Памяти у модели нет, поэтому история диалога приходит вместе с запросом. Расход считается по токенам из ответа
 * и прейскуранту (usage/pricing.ts) и отдаётся как расход одного хода (usageMode: delta).
 */
export class ChatRunner implements AgentRunner {
  constructor(private readonly client: ChatClient) {}

  async *run(input: AgentTurnInput): AsyncGenerator<AgentEvent> {
    const { policy, signal } = input;
    const system = typeof policy.systemPrompt === "string" ? policy.systemPrompt : "";
    const messages = buildMessages(input.history ?? [], input.prompt);
    const rates = ratesFor(policy.model);
    const inputEstimate = estimateTokens(system) + messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);
    const maxTokens = outputCap({
      budgetUsd: input.maxBudgetUsd,
      inputRate: rates.input,
      outputRate: rates.output,
      inputEstimate,
      ceiling: policy.maxOutputTokens,
    });

    const stream = this.client.messages.stream(
      {
        model: policy.model,
        max_tokens: maxTokens,
        system,
        messages,
        ...(policy.effort ? { output_config: { effort: policy.effort } } : {}),
        ...(input.userId ? { metadata: { user_id: input.userId } } : {}),
      },
      { signal },
    );

    let text = "";
    let started = false;
    let stopReason: string | null = null;
    const tokens = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    let failure: unknown;

    try {
      for await (const event of stream) {
        if (event.type === "message_start") {
          started = true;
          const usage = event.message.usage;
          tokens.inputTokens = count(usage?.input_tokens);
          tokens.outputTokens = count(usage?.output_tokens);
          tokens.cacheReadInputTokens = count(usage?.cache_read_input_tokens);
          tokens.cacheCreationInputTokens = count(usage?.cache_creation_input_tokens);
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta" && event.delta.text) {
            text += event.delta.text;
            yield { kind: "delta", text: event.delta.text };
          }
        } else if (event.type === "message_delta") {
          stopReason = event.delta.stop_reason ?? stopReason;
          const usage = event.usage;
          // В message_delta итоги нарастающие по этому запросу; поля, которых нет, оставляем из message_start.
          tokens.outputTokens = Math.max(tokens.outputTokens, count(usage?.output_tokens));
          tokens.inputTokens = Math.max(tokens.inputTokens, count(usage?.input_tokens));
          tokens.cacheReadInputTokens = Math.max(tokens.cacheReadInputTokens, count(usage?.cache_read_input_tokens));
          tokens.cacheCreationInputTokens = Math.max(tokens.cacheCreationInputTokens, count(usage?.cache_creation_input_tokens));
        }
      }
    } catch (error) {
      failure = error;
    }

    // Запрос не дошёл до модели (нет связи, отказ API): ничего не потрачено, пусть сервис сообщит об ошибке.
    if (failure !== undefined && !started) throw failure;

    // Ответ оборвался посреди генерации: число токенов вывода неизвестно точно, берём оценку по длине текста (с запасом).
    if (failure !== undefined) tokens.outputTokens = Math.max(tokens.outputTokens, estimateTokens(text));

    const model = policy.model;
    const cost = costOf(model, tokens);
    const overBudget = input.maxBudgetUsd !== undefined && cost > input.maxBudgetUsd + 1e-9;
    const refused = stopReason === "refusal";

    if (text.trim()) yield { kind: "text", text: stopReason === "max_tokens" ? `${text}${TRUNCATED_NOTE}` : text };

    const modelUsage: Snapshot = { [model]: { ...tokens, costUSD: cost } };
    const callTokens = tokens.inputTokens + tokens.outputTokens + tokens.cacheReadInputTokens + tokens.cacheCreationInputTokens;
    const subtype =
      failure !== undefined ? (signal.aborted ? "aborted" : "error_during_execution") : refused ? "refusal" : overBudget ? "error_max_budget_usd" : "success";
    yield {
      kind: "result",
      ok: subtype === "success",
      subtype,
      totalCostUsd: cost,
      modelUsage,
      usageMode: "delta",
      callTokens,
      errorMessage:
        failure !== undefined ? redactSecrets(failure instanceof Error ? failure.message : String(failure)).slice(0, 300) : refused ? "refusal" : undefined,
    };
  }
}
