import { describe, expect, it } from "vitest";
import { buildAgentEnv, callTokensOf, mapSdkMessage, summarizeTool, type MapState } from "../src/agent/claude-runner.js";
import { policyFor } from "../src/agent/policy.js";
import type { Actor } from "../src/types.js";
import { testConfig } from "./helpers.js";

const cfg = testConfig();

describe("policyFor - права определяет «дверь», а не заявление клиента", () => {
  const actor = (role: Actor["role"], entry: Actor["entry"]): Actor => ({ userId: "11111111-1111-4111-8111-111111111111", email: "a@b.co", role, entry });

  it("публичный: никаких инструментов, никаких разрешений", () => {
    const policy = policyFor(actor("public", "internal"), cfg);
    expect(policy.tier).toBe("public");
    expect(policy.tools).toEqual([]);
    expect(policy.allowedTools).toEqual([]);
    expect(policy.permissionMode).toBe("dontAsk");
    expect(policy.maxTurns).toBe(cfg.publicMaxTurns);
  });

  it("через внутреннюю дверь права публичные, даже если в БД роль выше", () => {
    expect(policyFor(actor("owner", "internal"), cfg).tools).toEqual([]);
    expect(policyFor(actor("trusted", "internal"), cfg).tier).toBe("public");
  });

  it("доверенный и владелец через прямую дверь получают терминал и файлы", () => {
    for (const role of ["owner", "trusted"] as const) {
      const policy = policyFor(actor(role, "direct"), cfg);
      expect(policy.tier).toBe("trusted");
      expect(policy.tools).toContain("Bash");
      expect(policy.allowedTools).toEqual(policy.tools);
      expect(policy.permissionMode).toBe("default");
    }
  });

  it("у каждого пользователя своя рабочая папка и свой каталог настроек", () => {
    const a = policyFor({ ...actor("trusted", "direct"), userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, cfg);
    const b = policyFor({ ...actor("trusted", "direct"), userId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, cfg);
    expect(a.cwd).not.toBe(b.cwd);
    expect(a.configDir).not.toBe(b.configDir);
    expect(a.cwd).toContain("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });

  it("публичная модель может отличаться от основной", () => {
    const custom = testConfig({ AGENT_MODEL: "claude-opus-5-5", PUBLIC_AGENT_MODEL: "claude-sonnet-5-5" });
    expect(policyFor(actor("public", "internal"), custom).model).toBe("claude-sonnet-5-5");
    expect(policyFor(actor("owner", "direct"), custom).model).toBe("claude-opus-5-5");
  });
});

describe("buildAgentEnv - секреты ядра не попадают в окружение агента", () => {
  it("вырезает секреты, оставляет нужное и добавляет ключ явно", () => {
    const env = buildAgentEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/node",
        DATABASE_URL: "postgres://user:pass@host/db",
        INTERNAL_API_SECRET: "secret",
        OWNER_EMAIL: "o@x.co",
        OWNER_PASSWORD: "pw",
        RAILWAY_TOKEN: "t",
        PGPASSWORD: "p",
        ANTHROPIC_API_KEY: "sk-ant-from-process-env",
        LANG: "C.UTF-8",
      },
      { ANTHROPIC_API_KEY: "sk-ant-explicit", CLAUDE_CONFIG_DIR: "/data/claude/u1" },
    );
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/node");
    expect(env.LANG).toBe("C.UTF-8");
    for (const hidden of ["DATABASE_URL", "INTERNAL_API_SECRET", "OWNER_EMAIL", "OWNER_PASSWORD", "RAILWAY_TOKEN", "PGPASSWORD"]) {
      expect(env).not.toHaveProperty(hidden);
    }
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-explicit");
    expect(env.CLAUDE_CONFIG_DIR).toBe("/data/claude/u1");
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
  });
});

describe("summarizeTool", () => {
  it("выбирает осмысленное поле для каждого инструмента", () => {
    expect(summarizeTool("Bash", { command: "ls -la" })).toBe("ls -la");
    expect(summarizeTool("Read", { file_path: "/a/b.txt" })).toBe("/a/b.txt");
    expect(summarizeTool("WebFetch", { url: "https://x.y" })).toBe("https://x.y");
    expect(summarizeTool("WebSearch", { query: "q" })).toBe("q");
    expect(summarizeTool("Weird", { foo: 1 })).toBe('{"foo":1}');
  });

  it("обрезает длинное и прячет ключи", () => {
    expect(summarizeTool("Bash", { command: "x".repeat(900) })).toHaveLength(501);
    expect(summarizeTool("Bash", { command: "curl -H 'x-api-key: sk-ant-api03-ABCDEFGH12345678'" })).toContain("sk-ant-***");
  });
});

describe("mapSdkMessage - перевод сообщений SDK в события ENTINEQ", () => {
  const run = (messages: unknown[]) => {
    const state: MapState = {};
    return messages.flatMap((message) => mapSdkMessage(message, state));
  };

  it("сообщает идентификатор сессии один раз", () => {
    const events = run([
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "assistant", session_id: "s1", parent_tool_use_id: null, message: { content: [{ type: "text", text: "привет" }] } },
    ]);
    expect(events.filter((e) => e.kind === "session")).toEqual([{ kind: "session", sessionId: "s1" }]);
  });

  it("текстовые куски потока становятся delta, прочие события потока игнорируются", () => {
    const events = run([
      { type: "stream_event", session_id: "s", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "text_delta", text: "При" } } },
      { type: "stream_event", session_id: "s", parent_tool_use_id: null, event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "…" } } },
      { type: "stream_event", session_id: "s", parent_tool_use_id: null, event: { type: "message_start" } },
    ]);
    expect(events.filter((e) => e.kind !== "session")).toEqual([{ kind: "delta", text: "При" }]);
  });

  it("assistant: текст и вызовы инструментов; размышления и пустой текст пропускаются", () => {
    const events = run([
      {
        type: "assistant",
        session_id: "s",
        parent_tool_use_id: null,
        message: {
          content: [
            { type: "thinking", thinking: "скрыто" },
            { type: "text", text: "  " },
            { type: "text", text: "Запускаю" },
            { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          ],
        },
      },
    ]);
    expect(events.filter((e) => e.kind !== "session")).toEqual([
      { kind: "text", text: "Запускаю" },
      { kind: "tool", name: "Bash", summary: "ls" },
    ]);
  });

  it("сообщения субагентов пользователю не показываются", () => {
    const events = run([
      { type: "assistant", session_id: "s", parent_tool_use_id: "toolu_1", message: { content: [{ type: "text", text: "внутренняя кухня" }] } },
      { type: "stream_event", session_id: "s", parent_tool_use_id: "toolu_1", event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } } },
    ]);
    expect(events.filter((e) => e.kind !== "session")).toEqual([]);
  });

  it("служебная ошибка API не выдаётся за ответ ассистента, а попадает в итог", () => {
    const events = run([
      { type: "assistant", session_id: "s", parent_tool_use_id: null, error: "authentication_failed", message: { content: [{ type: "text", text: "Invalid API key · Please run /login" }] } },
      { type: "result", subtype: "success", is_error: true, result: "", session_id: "s", total_cost_usd: 0, modelUsage: {} },
    ]);
    expect(events.some((e) => e.kind === "text")).toBe(false);
    const result = events.find((e) => e.kind === "result");
    expect(result).toMatchObject({ ok: false, errorMessage: "authentication_failed" });
  });

  it("result: успех несёт накопительные итоги по моделям", () => {
    const events = run([
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: "ок",
        session_id: "s",
        total_cost_usd: 0.42,
        modelUsage: { "claude-opus-5-5": { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.42 } },
      },
    ]);
    const result = events.find((e) => e.kind === "result");
    expect(result).toMatchObject({ ok: true, subtype: "success", totalCostUsd: 0.42, sessionId: "s" });
    expect((result as { modelUsage: Record<string, unknown> }).modelUsage["claude-opus-5-5"]).toBeDefined();
  });

  it("result: токены самого вызова берутся из usage (а не из накопительных итогов)", () => {
    const events = run([
      {
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "s",
        total_cost_usd: 5,
        usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 10 },
        modelUsage: { m: { inputTokens: 9000, outputTokens: 400, cacheReadInputTokens: 9000, cacheCreationInputTokens: 100, costUSD: 5 } },
      },
    ]);
    expect((events.find((e) => e.kind === "result") as { callTokens?: number }).callTokens).toBe(1050);
    expect(callTokensOf(undefined)).toBeUndefined();
    expect(callTokensOf({})).toBeUndefined();
    expect(callTokensOf({ input_tokens: "много" })).toBeUndefined();
  });

  it("result: ошибочные подтипы помечаются как неуспех и очищаются от секретов", () => {
    const events = run([
      { type: "result", subtype: "error_max_turns", is_error: true, errors: ["лимит шагов"], session_id: "s", total_cost_usd: 0.1, modelUsage: {} },
      { type: "result", subtype: "error_during_execution", is_error: true, errors: ["ключ sk-ant-api03-ABCDEFGHIJKL не подошёл"], session_id: "s", total_cost_usd: 0, modelUsage: {} },
    ]);
    const results = events.filter((e) => e.kind === "result") as { ok: boolean; subtype: string; errorMessage?: string }[];
    expect(results.map((r) => [r.ok, r.subtype])).toEqual([[false, "error_max_turns"], [false, "error_during_execution"]]);
    expect(results[1]!.errorMessage).not.toContain("ABCDEFGHIJKL");
  });

  it("неожиданные формы не приводят к исключениям", () => {
    expect(() => run([null, undefined, 5, "строка", [], {}, { type: "assistant" }, { type: "assistant", message: { content: "не массив" } }, { type: "stream_event" }, { type: "result" }])).not.toThrow();
  });
});
