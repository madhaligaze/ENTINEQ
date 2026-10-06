import { join } from "node:path";
import type { Config } from "../config.js";
import type { Actor } from "../types.js";

export interface AgentPolicy {
  tier: "trusted" | "public";
  model: string;
  maxTurns: number;
  /** Какие встроенные инструменты вообще существуют для агента ([] — никаких). */
  tools: string[];
  /** Какие из них разрешены без подтверждения. */
  allowedTools: string[];
  permissionMode: "default" | "dontAsk";
  systemPrompt: string | { type: "preset"; preset: "claude_code"; append: string; snapshot: boolean };
  cwd: string;
  configDir: string;
}

const TRUSTED_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch"];

const PUBLIC_PROMPT =
  "Ты — ассистент сервиса ENTINEQ на базе Claude. Отвечай на языке пользователя, по делу. " +
  "У тебя нет доступа к файлам, терминалу и интернету: если для ответа это нужно, скажи об этом прямо и не выдумывай результаты.";

/**
 * Права агента определяет «дверь», через которую пришёл запрос, а не то, что сообщил клиент.
 * Публичный уровень — только чат, без инструментов: процесс агента живёт рядом с ключами ядра,
 * поэтому терминал публичным пользователям появится только вместе с изолированной песочницей.
 */
export function policyFor(actor: Actor, cfg: Config): AgentPolicy {
  const isPublic = actor.entry === "internal" || actor.role === "public";
  const configDir = join(cfg.dataDir, "claude", actor.userId);

  if (isPublic) {
    return {
      tier: "public",
      model: cfg.publicAgentModel,
      maxTurns: cfg.publicMaxTurns,
      tools: [],
      allowedTools: [],
      permissionMode: "dontAsk",
      systemPrompt: PUBLIC_PROMPT,
      cwd: join(cfg.dataDir, "public", actor.userId),
      configDir,
    };
  }

  const cwd = join(cfg.dataDir, "workspaces", actor.userId);
  return {
    tier: "trusted",
    model: cfg.agentModel,
    maxTurns: cfg.trustedMaxTurns,
    tools: TRUSTED_TOOLS,
    allowedTools: TRUSTED_TOOLS,
    permissionMode: "default",
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: `Ты работаешь в сервисе ENTINEQ_AGENT. Отвечай на языке пользователя. Твоя рабочая папка: ${cwd}. Создавай и меняй файлы только в ней.`,
      snapshot: true,
    },
    cwd,
    configDir,
  };
}
