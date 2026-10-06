import { mkdir } from "node:fs/promises";
import { query, type Options, type SessionStore } from "@anthropic-ai/claude-agent-sdk";
import { redactSecrets } from "../errors.js";
import { normalizeModelUsage } from "../usage/ledger.js";
import { summarizeTool } from "./summary.js";
import type { AgentEvent, AgentRunner, AgentTurnInput } from "./types.js";

export { summarizeTool };

/** Имена переменных окружения, которые агент не должен видеть (у него есть терминал). */
const SENSITIVE_ENV = /(SECRET|PASSWORD|PASSWD|TOKEN|DATABASE|PGPASSWORD|PRIVATE|CREDENTIAL)/i;

/**
 * Окружение процесса агента: всё полезное (PATH, HOME…), но без секретов ядра - строки подключения к БД,
 * внутреннего секрета, пароля владельца. Ключ Anthropic передаём явно: он нужен самому SDK.
 */
export function buildAgentEnv(
  source: NodeJS.ProcessEnv,
  extra: { ANTHROPIC_API_KEY: string; CLAUDE_CONFIG_DIR: string },
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || SENSITIVE_ENV.test(name) || name.startsWith("OWNER_") || name === "ANTHROPIC_API_KEY") continue;
    env[name] = value;
  }
  return {
    ...env,
    ...extra,
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_AUTOUPDATER: "1",
    CLAUDE_AGENT_SDK_CLIENT_APP: "entineq-agent/0.2",
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/** Токены самого вызова из поля `usage` результата (оно считается по основному циклу и не накопительное). */
export function callTokensOf(usage: unknown): number | undefined {
  const data = asRecord(usage);
  if (!data) return undefined;
  const fields = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
  const values = fields.map((field) => (typeof data[field] === "number" && Number.isFinite(data[field]) ? (data[field] as number) : 0));
  const total = values.reduce((sum, value) => sum + value, 0);
  return total > 0 ? total : undefined;
}

export interface MapState {
  sessionId?: string;
  /** Ошибка API, о которой сообщило само SDK в служебном сообщении ассистента. */
  apiError?: string;
}

/** Превращает одно сообщение SDK в события ENTINEQ. Не бросает исключений на неожиданных формах. */
export function mapSdkMessage(raw: unknown, state: MapState): AgentEvent[] {
  const message = asRecord(raw);
  if (!message) return [];
  const events: AgentEvent[] = [];

  if (typeof message.session_id === "string" && message.session_id && message.session_id !== state.sessionId) {
    state.sessionId = message.session_id;
    events.push({ kind: "session", sessionId: message.session_id });
  }
  // Сообщения субагентов (parent_tool_use_id задан) пользователю не показываем.
  const isNested = message.parent_tool_use_id !== null && message.parent_tool_use_id !== undefined;

  switch (message.type) {
    case "stream_event": {
      const event = asRecord(message.event);
      const delta = asRecord(event?.delta);
      if (!isNested && event?.type === "content_block_delta" && delta?.type === "text_delta" && typeof delta.text === "string") {
        events.push({ kind: "delta", text: delta.text });
      }
      break;
    }
    case "assistant": {
      if (isNested) break;
      if (message.error) {
        // Текст служебной ошибки API ответом ассистента не считаем.
        state.apiError = String(message.error);
        break;
      }
      const content = asRecord(message.message)?.content;
      if (!Array.isArray(content)) break;
      for (const block of content) {
        const item = asRecord(block);
        if (item?.type === "text" && typeof item.text === "string" && item.text.trim()) {
          events.push({ kind: "text", text: item.text });
        } else if (item?.type === "tool_use" && typeof item.name === "string") {
          events.push({ kind: "tool", name: item.name, summary: summarizeTool(item.name, item.input) });
        }
      }
      break;
    }
    case "result": {
      const subtype = typeof message.subtype === "string" ? message.subtype : "unknown";
      const failed = message.is_error === true || subtype !== "success";
      const errors = Array.isArray(message.errors) ? message.errors.map(String).join("; ") : "";
      const text = subtype === "success" ? String(message.result ?? "") : errors;
      const errorMessage = failed ? redactSecrets(text || state.apiError || subtype) : undefined;
      events.push({
        kind: "result",
        ok: !failed,
        subtype,
        sessionId: typeof message.session_id === "string" ? message.session_id : undefined,
        totalCostUsd: typeof message.total_cost_usd === "number" ? message.total_cost_usd : 0,
        modelUsage: normalizeModelUsage(message.modelUsage),
        callTokens: callTokensOf(message.usage),
        errorMessage,
      });
      break;
    }
    default:
      break;
  }
  return events;
}

export class ClaudeAgentRunner implements AgentRunner {
  constructor(
    private readonly apiKey: string,
    private readonly sessionStore: SessionStore,
  ) {}

  async *run(input: AgentTurnInput): AsyncGenerator<AgentEvent> {
    const { policy } = input;
    await mkdir(policy.cwd, { recursive: true });
    await mkdir(policy.configDir, { recursive: true });

    const abortController = new AbortController();
    const forwardAbort = () => abortController.abort(input.signal.reason);
    if (input.signal.aborted) forwardAbort();
    else input.signal.addEventListener("abort", forwardAbort, { once: true });

    const options: Options = {
      abortController,
      cwd: policy.cwd,
      env: buildAgentEnv(process.env, { ANTHROPIC_API_KEY: this.apiKey, CLAUDE_CONFIG_DIR: policy.configDir }),
      model: policy.model,
      maxTurns: policy.maxTurns,
      tools: policy.tools,
      allowedTools: policy.allowedTools,
      permissionMode: policy.permissionMode,
      // Интерактивного подтверждения в интерфейсе нет: всё, что не разрешено заранее, запрещаем.
      canUseTool: async (toolName) => ({ behavior: "deny", message: `Инструмент ${toolName} недоступен.` }),
      settingSources: [],
      strictMcpConfig: true,
      systemPrompt: policy.systemPrompt,
      includePartialMessages: true,
      persistSession: true,
      sessionStore: this.sessionStore,
      ...(input.maxBudgetUsd !== undefined ? { maxBudgetUsd: input.maxBudgetUsd } : {}),
      ...(input.sdkSessionId ? { resume: input.sdkSessionId } : {}),
    };

    const stream = query({ prompt: input.prompt, options });
    const state: MapState = { sessionId: input.sdkSessionId };
    try {
      for await (const message of stream) {
        for (const event of mapSdkMessage(message, state)) yield event;
      }
    } finally {
      input.signal.removeEventListener("abort", forwardAbort);
      stream.close();
    }
  }
}
