import { mountAdmin } from "./admin.js";
import { api, setUnauthorizedHandler } from "./api.js";
import { Chat } from "./chat.js";
import { $, clear, el } from "./dom.js";
import { blockFromUsage, fmtCountdown } from "./format.js";
import { createUsagePanel } from "./usage.js";

const views = { boot: $("boot-view"), login: $("login-view"), app: $("app-view") };
const terminal = $("terminal");
const banner = $("banner");

let block = null;
let notice = null;
let noticeTimer = null;
let lastRefresh = 0;
let adminApi = null;
let inApp = false;

function show(view) {
  for (const [name, node] of Object.entries(views)) node.hidden = name !== view;
}

/* ---------- баннер: ограничение лимитом (постоянное) и разовые сообщения ---------- */
function renderBanner() {
  if (block) {
    const left = block.resetsAt === null ? null : block.resetsAt - Date.now();
    const suffix =
      left === null ? "" : left > 0 ? ` ${block.kind === "month" ? "Лимит обновится" : "Новое окно откроется"} через ${fmtCountdown(left)}.` : " Проверяю обновление лимита…";
    banner.className = "banner";
    banner.textContent = `${block.text}${suffix}`;
    banner.hidden = false;
  } else if (notice) {
    banner.className = "banner error";
    banner.textContent = notice;
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

function showNotice(text) {
  notice = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice = null;
    renderBanner();
  }, 8000);
  renderBanner();
}

async function refreshUsage() {
  lastRefresh = Date.now();
  try {
    const me = await api("GET", "/api/me");
    applyUsage(me.usage);
  } catch {
    // Если сессия закончилась, глобальный обработчик 401 уже показал вход.
  }
}

const usagePanel = createUsagePanel({
  onTick: () => {
    renderBanner();
    if (block && block.resetsAt !== null && Date.now() >= block.resetsAt && Date.now() - lastRefresh > 5000) void refreshUsage();
  },
  onExpire: () => void refreshUsage(),
});

function applyUsage(usage) {
  usagePanel.update(usage);
  block = blockFromUsage(usage);
  chat.setBlocked(block !== null);
  renderBanner();
}

/* ---------- терминал (действия агента) ---------- */
function termLine(kind, text) {
  terminal.append(el("div", { class: `line ${kind}`, text }));
  terminal.scrollTop = terminal.scrollHeight;
}

const chat = new Chat({
  messages: $("messages"),
  composer: $("composer"),
  input: $("input"),
  send: $("send"),
  status: $("status"),
  list: $("conversation-list"),
  newButton: $("new-chat"),
  wsPath: "/ws",
  apiBase: "/api",
  hint: "Напишите задачу агенту. Он может читать и менять файлы и выполнять команды в своей рабочей папке.",
  placeholder: "Напишите задачу агенту…",
  onUsage: applyUsage,
  onTool: (event) => (event.name === "Bash" ? termLine("cmd", event.summary) : termLine("meta", `${event.name}: ${event.summary}`)),
  onToolsReset: () => clear(terminal),
  onError: showNotice,
  onAuthLost: () => showLogin("Сессия закончилась. Войдите снова."),
  onOpened: () => closeSidebar(),
});

/* ---------- вкладки и боковая панель ---------- */
function selectTab(name) {
  $("chat-screen").hidden = name !== "chat";
  $("admin-screen").hidden = name !== "admin";
  for (const [id, tab] of [["chat", $("tab-chat")], ["admin", $("tab-admin")]]) {
    tab.classList.toggle("active", id === name);
    if (id === name) tab.setAttribute("aria-current", "page");
    else tab.removeAttribute("aria-current");
  }
  if (name === "admin" && adminApi) void adminApi.load();
}
$("tab-chat").addEventListener("click", () => selectTab("chat"));
$("tab-admin").addEventListener("click", () => selectTab("admin"));

function closeSidebar() {
  $("sidebar").classList.remove("open");
  $("sidebar-toggle").setAttribute("aria-expanded", "false");
}
$("sidebar-toggle").addEventListener("click", () => {
  const open = $("sidebar").classList.toggle("open");
  $("sidebar-toggle").setAttribute("aria-expanded", String(open));
});

/* ---------- вход и выход ---------- */
function showLogin(message) {
  inApp = false;
  chat.stop();
  usagePanel.stop();
  block = null;
  notice = null;
  clear($("admin-root"));
  adminApi = null;
  $("login-error").hidden = !message;
  $("login-error").textContent = message ?? "";
  show("login");
  $("login-email").focus();
}

function enterApp({ user, usage }) {
  inApp = true;
  $("user-email").textContent = user.email;
  $("tab-admin").hidden = user.role !== "owner";
  clear($("admin-root"));
  adminApi = user.role === "owner" ? mountAdmin($("admin-root")) : null;
  show("app");
  selectTab("chat");
  closeSidebar();
  chat.start();
  applyUsage(usage);
  $("input").focus();
}

setUnauthorizedHandler(() => {
  if (inApp) showLogin("Сессия закончилась. Войдите снова.");
});

$("login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = $("login-email").value.trim();
  const password = $("login-password").value;
  const error = $("login-error");
  if (!email || !password) {
    error.textContent = "Введите email и пароль.";
    error.hidden = false;
    return;
  }
  $("login-submit").disabled = true;
  try {
    const data = await api("POST", "/api/auth/login", { email, password }, { silent401: true });
    $("login-password").value = "";
    error.hidden = true;
    enterApp(data);
  } catch (failure) {
    error.textContent = failure.message;
    error.hidden = false;
  } finally {
    $("login-submit").disabled = false;
  }
});

$("logout").addEventListener("click", async () => {
  try {
    await api("POST", "/api/auth/logout", undefined, { silent401: true });
  } catch {
    // Выходим локально в любом случае.
  }
  showLogin();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && inApp) void refreshUsage();
});

/* ---------- старт ---------- */
(async () => {
  try {
    enterApp(await api("GET", "/api/me", undefined, { silent401: true }));
  } catch (error) {
    if (error.status === 401) showLogin();
    else {
      show("login");
      $("login-error").textContent = error.message;
      $("login-error").hidden = false;
    }
  }
})();
