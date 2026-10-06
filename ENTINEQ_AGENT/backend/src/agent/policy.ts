import { join } from "node:path";
import type { Config } from "../config.js";
import type { Actor, Engine } from "../types.js";

export interface AgentPolicy {
  tier: "trusted" | "public" | "sandbox";
  model: string;
  maxTurns: number;
  /** Какие встроенные инструменты вообще существуют для агента ([] - никаких). */
  tools: string[];
  /** Какие из них разрешены без подтверждения. */
  allowedTools: string[];
  permissionMode: "default" | "dontAsk";
  systemPrompt: string | { type: "preset"; preset: "claude_code"; append: string; snapshot: boolean };
  cwd: string;
  configDir: string;
  /** Потолок длины одного ответа, токенов (только для chat). */
  maxOutputTokens: number;
  /** Усилие модели (только для chat; не задано - по умолчанию модели). */
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

const TRUSTED_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebSearch", "WebFetch"];
/** Инструменты песочницы (так их называет заглушка; настоящий набор задаёт агент Managed Agents, см. scripts/sandbox-setup.ts). */
const SANDBOX_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"];

const PUBLIC_PROMPT =
  "Ты - ассистент сервиса ENTINEQ на базе Claude. Отвечай на языке пользователя, по делу. " +
  "У тебя нет доступа к файлам, терминалу и интернету: если для ответа это нужно, скажи об этом прямо и не выдумывай результаты.";

const SANDBOX_PROMPT =
  "Ты - ассистент сервиса ENTINEQ на базе Claude с доступом к терминалу в изолированной песочнице. Отвечай на языке пользователя. " +
  "Песочница временная и принадлежит только этому диалогу: создавай и запускай в ней файлы и программы, когда это помогает решить задачу. " +
  "Секретов и чужих данных здесь нет.";

/**
 * Права агента определяет «дверь», через которую пришёл запрос, а не то, что сообщил клиент.
 * Публичные пользователи получают только чат без инструментов (chat) либо терминал в изолированной песочнице Anthropic
 * (managed, по подписке): процесс агента с терминалом внутри контейнера ядра, рядом с ключами, им никогда не выдаётся.
 */
export function policyFor(actor: Actor, cfg: Config, engine: Engine): AgentPolicy {
  const isPublic = actor.entry === "internal" || actor.role === "public";
  const configDir = join(cfg.dataDir, "claude", actor.userId);
  const common = { permissionMode: "dontAsk" as const, maxOutputTokens: cfg.publicMaxOutputTokens, effort: cfg.publicEffort };

  if (engine === "agent") {
    if (isPublic) throw new Error("Публичному пользователю нельзя запускать агента в контейнере ядра.");
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
      maxOutputTokens: cfg.publicMaxOutputTokens,
    };
  }

  if (!isPublic) throw new Error("Движки chat и managed предназначены для публичных пользователей.");

  if (engine === "chat") {
    return {
      ...common,
      tier: "public",
      model: cfg.publicAgentModel,
      maxTurns: 1,
      tools: [],
      allowedTools: [],
      systemPrompt: PUBLIC_PROMPT,
      cwd: join(cfg.dataDir, "public", actor.userId),
      configDir,
    };
  }

  return {
    ...common,
    tier: "sandbox",
    model: cfg.publicAgentModel,
    maxTurns: cfg.trustedMaxTurns,
    tools: SANDBOX_TOOLS,
    allowedTools: SANDBOX_TOOLS,
    systemPrompt: SANDBOX_PROMPT,
    cwd: join(cfg.dataDir, "sandbox", actor.userId),
    configDir,
  };
}
