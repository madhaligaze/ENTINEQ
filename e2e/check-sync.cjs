/*
 * Проверка, что намеренно продублированные файлы четырёх репозиториев не разошлись.
 * Запуск: node e2e/check-sync.cjs   (код выхода 1, если есть расхождения)
 */
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const list = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => fs.statSync(path.join(dir, f)).isFile()).sort() : []);

const A_FRONT = path.join(ROOT, "ENTINEQ_AGENT", "frontend");
const P_FRONT = path.join(ROOT, "ENTINEQ", "frontend");
const A_BACK = path.join(ROOT, "ENTINEQ_AGENT", "backend");
const P_BACK = path.join(ROOT, "ENTINEQ", "backend");

const groups = [
  ["Код сервиса пересылки (frontend/src)", A_FRONT, P_FRONT, "src", null],
  ["Тесты сервиса пересылки (frontend/test)", A_FRONT, P_FRONT, "test", null],
  ["Модули интерфейса чата (frontend/public/js)", A_FRONT, P_FRONT, path.join("public", "js"), ["api.js", "dom.js", "format.js", "usage.js", "chat.js"]],
  ["Прослушивание адреса (backend/src/listen.ts)", A_BACK, P_BACK, "src", ["listen.ts"]],
  ["Прослушивание адреса - тест (backend/test/listen.test.ts)", A_BACK, P_BACK, "test", ["listen.test.ts"]],
  ["Страж длинного тире (backend/test/no-long-dash.test.ts)", A_BACK, P_BACK, "test", ["no-long-dash.test.ts"]],
];

let bad = 0;
for (const [title, left, right, sub, only] of groups) {
  const files = only ?? list(path.join(left, sub));
  const diffs = [];
  for (const file of files) {
    const a = path.join(left, sub, file);
    const b = path.join(right, sub, file);
    if (!fs.existsSync(a) || !fs.existsSync(b)) diffs.push(`${file}: нет в одном из репозиториев`);
    else if (hash(a) !== hash(b)) diffs.push(`${file}: различается`);
  }
  if (!only) {
    const extra = list(path.join(right, sub)).filter((f) => !files.includes(f));
    for (const f of extra) diffs.push(`${f}: есть только в ENTINEQ`);
  }
  console.log(`${diffs.length ? "  ✗" : "  ✓"} ${title} (${files.length} файлов)${diffs.length ? "\n      " + diffs.join("\n      ") : ""}`);
  bad += diffs.length;
}

// Версия внутреннего контракта: в ядре и в публичном бэкенде должна совпадать.
const coreContract = /INTERNAL_CONTRACT_VERSION\s*=\s*(\d+)/.exec(fs.readFileSync(path.join(A_BACK, "src", "routes", "internal.ts"), "utf8"))?.[1];
const pubContract = /EXPECTED_CONTRACT\s*=\s*(\d+)/.exec(fs.readFileSync(path.join(P_BACK, "src", "contract.ts"), "utf8"))?.[1];
const contractOk = coreContract && coreContract === pubContract;
console.log(`${contractOk ? "  ✓" : "  ✗"} Версия внутреннего контракта: ядро=${coreContract}, публичный бэкенд=${pubContract}`);
if (!contractOk) bad += 1;

console.log(bad ? `\nРасхождений: ${bad}` : "\nВсё синхронно.");
process.exit(bad ? 1 : 0);
