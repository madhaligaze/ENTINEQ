import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Правило проекта из CLAUDE.md: длинное тире (U+2014) не пишем нигде - ни в интерфейсе, ни в сообщениях сервера,
 * ни в комментариях, ни в документации. Вместо него короткий дефис с пробелами. Символ здесь собран из кода,
 * чтобы сам тест его не содержал и не срабатывал на себя.
 */
const LONG_DASH = String.fromCharCode(0x2014);
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP = new Set(["node_modules", "dist", ".git", ".data", "coverage"]);
const TEXT_FILE = /\.(ts|js|cjs|mjs|json|md|html|css|sql|yml|yaml|example)$|^(Dockerfile|\.dockerignore|\.gitignore|\.gitattributes)$/;

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (TEXT_FILE.test(name) && name !== "pnpm-lock.yaml") yield full;
  }
}

describe("правило проекта: без длинного тире", () => {
  it("в файлах репозитория нет символа U+2014", () => {
    const found = [...walk(ROOT)].filter((file) => readFileSync(file, "utf8").includes(LONG_DASH)).map((file) => relative(ROOT, file));
    expect(found).toEqual([]);
  });
});
