import { redactSecrets } from "../errors.js";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

/**
 * Коротко описывает вызов инструмента для панели «действия агента». Имена сравниваются без учёта регистра:
 * в Agent SDK они пишутся Bash, в Managed Agents - bash.
 */
export function summarizeTool(name: string, input: unknown): string {
  const data = asRecord(input) ?? {};
  const pick = (...keys: string[]) => keys.map((key) => data[key]).find((value): value is string => typeof value === "string");
  const tool = name.toLowerCase();
  const text =
    tool === "bash" ? pick("command")
    : tool === "read" || tool === "write" || tool === "edit" ? pick("file_path", "path")
    : tool === "webfetch" || tool === "web_fetch" ? pick("url")
    : tool === "websearch" || tool === "web_search" ? pick("query")
    : pick("pattern", "command", "file_path", "path", "url", "query");
  const summary = text ?? JSON.stringify(input ?? {});
  return redactSecrets(summary.length > 500 ? `${summary.slice(0, 500)}…` : summary);
}
