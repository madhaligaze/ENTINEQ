/*
 * Правило проекта из CLAUDE.md: длинное тире (U+2014) не пишем нигде. Скрипт ищет его во всём рабочем каталоге:
 * в четырёх репозиториях, в e2e, в корневых README и docker-compose.yml. (Внутри репозиториев то же самое делает
 * тест test/no-long-dash.test.ts.) Символ собран из кода, чтобы скрипт сам его не содержал.
 * Запуск: node e2e/check-style.cjs   (код выхода 1, если нашлось)
 */
const fs = require("node:fs");
const path = require("node:path");

const LONG_DASH = String.fromCharCode(0x2014);
const ROOT = path.resolve(__dirname, "..");
const SKIP = new Set(["node_modules", "dist", ".git", ".data", "coverage", ".claude"]);
const TEXT_FILE = /\.(ts|js|cjs|mjs|json|md|html|css|sql|yml|yaml|example)$|^(Dockerfile|\.dockerignore|\.gitignore|\.gitattributes)$/;

const found = [];
let scanned = 0;
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full);
    else if (TEXT_FILE.test(name) && name !== "pnpm-lock.yaml") {
      scanned++;
      const text = fs.readFileSync(full, "utf8");
      const at = text.indexOf(LONG_DASH);
      if (at !== -1) found.push(`${path.relative(ROOT, full)} (строка ${text.slice(0, at).split("\n").length})`);
    }
  }
})(ROOT);

console.log(`Проверено файлов: ${scanned}`);
if (found.length) {
  console.log("Длинное тире найдено:\n  " + found.join("\n  "));
  process.exit(1);
}
console.log("Длинного тире нет.");
