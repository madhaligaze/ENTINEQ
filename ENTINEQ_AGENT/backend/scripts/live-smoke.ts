/**
 * Живая проверка с настоящим Claude: три коротких хода на публичных правах (без инструментов).
 * Тратит реальные деньги (порядка нескольких центов) — поэтому запускается только с флагом --yes:
 *
 *   pnpm smoke:live -- --yes
 *
 * Нужны ANTHROPIC_API_KEY (в окружении или в .env). Модель берётся из PUBLIC_AGENT_MODEL / AGENT_MODEL;
 * для самой дешёвой проверки задайте PUBLIC_AGENT_MODEL=claude-haiku-4-5.
 *
 * Что проверяется — всё, чего нельзя проверить без настоящего API:
 *   1. адаптер Agent SDK получает ответ и сообщает идентификатор сессии;
 *   2. продолжение диалога (resume) сохраняет контекст и тот же идентификатор сессии;
 *   3. итоги расхода по моделям: накопительные они или нет — и совпадает ли учёт ENTINEQ с итогом SDK;
 *   4. транскрипт сессии попадает в Postgres-хранилище и по нему диалог продолжается «в новом контейнере».
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { policyFor, type AgentPolicy } from "../src/agent/policy.js";
import { createPgSessionStore } from "../src/agent/session-store.js";
import { ClaudeAgentRunner } from "../src/agent/claude-runner.js";
import type { AgentEvent } from "../src/agent/types.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { sdkSessionEntries } from "../src/db/schema.js";
import { classifyUsage, diffUsage, type Snapshot } from "../src/usage/ledger.js";

if (!process.argv.includes("--yes")) {
  console.log("Этот скрипт тратит реальные деньги (порядка нескольких центов). Запустите с флагом: pnpm smoke:live -- --yes");
  process.exit(2);
}

const cfg = loadConfig({
  ...process.env,
  AGENT_RUNNER: "claude",
  INTERNAL_API_SECRET: process.env.INTERNAL_API_SECRET ?? "smoke-test-secret-0123456789abcdef-0123456789",
  DATA_DIR: await mkdtemp(join(tmpdir(), "entineq-smoke-")),
});
const apiKey = cfg.anthropicApiKey!;

const results: { name: string; ok: boolean; detail?: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "  ✓" : "  ✗ ПРОВАЛ:"} ${name}${detail ? `  — ${detail}` : ""}`);
};

const handle = await openDb({ pglite: "memory" });
await handle.migrate();
const store = createPgSessionStore(handle.db);
const runner = new ClaudeAgentRunner(apiKey, store);

const actor = { userId: "00000000-0000-4000-8000-000000000001", email: "smoke@example.com", role: "public" as const, entry: "internal" as const };
const policy: AgentPolicy = policyFor(actor, cfg);
console.log(`Модель: ${policy.model}. Ход ограничен суммой $0.25.\n`);

async function turn(prompt: string, sdkSessionId: string | undefined, withPolicy: AgentPolicy) {
  const events: AgentEvent[] = [];
  const started = Date.now();
  for await (const event of runner.run({ prompt, sdkSessionId, policy: withPolicy, maxBudgetUsd: 0.25, signal: AbortSignal.timeout(120_000) })) events.push(event);
  const text = events.filter((e) => e.kind === "text").map((e) => (e as { text: string }).text).join("\n");
  const result = events.find((e) => e.kind === "result") as Extract<AgentEvent, { kind: "result" }> | undefined;
  const session = events.find((e) => e.kind === "session") as { sessionId: string } | undefined;
  console.log(`  [${((Date.now() - started) / 1000).toFixed(1)} с] «${prompt}»\n    → «${text.slice(0, 160)}»`);
  return { events, text, result, sessionId: result?.sessionId ?? session?.sessionId };
}

try {
  console.log("Ход 1: новая сессия");
  const first = await turn("Запомни слово «бирюза». Ответь одним словом: «запомнил».", undefined, policy);
  check("ответ получен, результат успешный", Boolean(first.result?.ok) && first.text.length > 0, first.result?.errorMessage ?? "");
  check("есть идентификатор сессии", Boolean(first.sessionId));
  check("есть итоги по моделям и токены вызова", Object.keys(first.result?.modelUsage ?? {}).length > 0 && (first.result?.callTokens ?? 0) > 0, JSON.stringify({ callTokens: first.result?.callTokens, cost: first.result?.totalCostUsd }));
  check("текст пришёл кусками (потоковые события)", first.events.some((e) => e.kind === "delta"), "если нет — интерфейс покажет ответ сразу целиком");

  console.log("\nХод 2: продолжение сессии (resume)");
  const second = await turn("Какое слово я просил запомнить? Ответь одним словом.", first.sessionId, policy);
  check("контекст сохранился", /бирюз/i.test(second.text), second.text);
  check("идентификатор сессии прежний", second.sessionId === first.sessionId, `${first.sessionId} → ${second.sessionId}`);

  const prev: Snapshot = first.result!.modelUsage;
  const next: Snapshot = second.result!.modelUsage;
  const mode = classifyUsage(prev, next, second.result!.callTokens);
  const deltas = diffUsage(prev, next, second.result!.callTokens);
  const deltaCost = deltas.reduce((sum, d) => sum + d.costUSD, 0);
  console.log(`    итоги SDK: ход 1 = $${first.result!.totalCostUsd.toFixed(5)}, ход 2 = $${second.result!.totalCostUsd.toFixed(5)}; токены вызова: ${second.result!.callTokens}`);
  console.log(`    ENTINEQ определил режим итогов: «${mode}», расход хода 2 = $${deltaCost.toFixed(5)}`);
  const expectedIfCumulative = second.result!.totalCostUsd - first.result!.totalCostUsd;
  const expectedIfRestart = second.result!.totalCostUsd;
  const matches = mode === "cumulative" ? Math.abs(deltaCost - expectedIfCumulative) < 1e-6 : Math.abs(deltaCost - expectedIfRestart) < 1e-6;
  check("учёт расхода за ход согласован с итогами SDK", matches, `режим ${mode}`);
  console.log(
    mode === "cumulative"
      ? "    (итоги SDK накопительные — как и описано в документации)"
      : "    (внимание: итоги SDK начались заново — учёт это обрабатывает, но стоит сообщить об этом разработчику)",
  );

  const stored = await handle.db.select({ seq: sdkSessionEntries.seq }).from(sdkSessionEntries);
  check("транскрипт сессии записан в Postgres-хранилище", stored.length > 0, `записей: ${stored.length}`);

  console.log("\nХод 3: «новый контейнер» — пустая локальная папка, сессия поднимается только из Postgres");
  const freshConfigDir = await mkdtemp(join(tmpdir(), "entineq-smoke-fresh-"));
  const third = await turn("Повтори слово, которое я просил запомнить, одним словом.", first.sessionId, { ...policy, configDir: freshConfigDir });
  check("диалог продолжился из хранилища и помнит контекст", /бирюз/i.test(third.text), third.text);
  const mode3 = classifyUsage(next, third.result!.modelUsage, third.result!.callTokens);
  console.log(`    после «переезда» режим итогов: «${mode3}»`);
} catch (error) {
  check("скрипт не упал с исключением", false, error instanceof Error ? error.message : String(error));
} finally {
  await handle.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\nИтого: ${results.length - failed.length} из ${results.length} проверок пройдено.`);
  process.exit(failed.length ? 1 : 0);
}
