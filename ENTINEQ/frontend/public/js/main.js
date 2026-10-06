import { api, setUnauthorizedHandler } from "./api.js";
import { Chat } from "./chat.js";
import { $ } from "./dom.js";
import { blockFromUsage, fmtCountdown } from "./format.js";
import { createUsagePanel } from "./usage.js";

const views = { boot: $("boot-view"), auth: $("auth-view"), app: $("app-view") };
const banner = $("banner");

let block = null;
let notice = null;
let noticeTimer = null;
let lastRefresh = 0;
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
  hint: "Чем помочь? Задайте вопрос — Claude ответит.",
  placeholder: "Спросите что-нибудь…",
  onUsage: applyUsage,
  onTool: () => {},
  onToolsReset: () => {},
  onError: showNotice,
  onAuthLost: () => showAuth("Сессия закончилась. Войдите снова."),
  onOpened: () => closeSidebar(),
});

/* ---------- боковая панель на телефоне ---------- */
function closeSidebar() {
  $("sidebar").classList.remove("open");
  $("sidebar-toggle").setAttribute("aria-expanded", "false");
}
$("sidebar-toggle").addEventListener("click", () => {
  const open = $("sidebar").classList.toggle("open");
  $("sidebar-toggle").setAttribute("aria-expanded", String(open));
});

/* ---------- вход и регистрация ---------- */
function setMode(mode) {
  const login = mode === "login";
  $("login-form").hidden = !login;
  $("register-form").hidden = login;
  $("tab-login").setAttribute("aria-selected", String(login));
  $("tab-register").setAttribute("aria-selected", String(!login));
  $("login-error").hidden = true;
  $("register-error").hidden = true;
  (login ? $("login-email") : $("register-code")).focus();
}
$("tab-login").addEventListener("click", () => setMode("login"));
$("tab-register").addEventListener("click", () => setMode("register"));

function showAuth(message) {
  inApp = false;
  chat.stop();
  usagePanel.stop();
  block = null;
  notice = null;
  show("auth");
  setMode("login");
  if (message) {
    $("login-error").textContent = message;
    $("login-error").hidden = false;
  }
}

function enterApp({ user, usage }) {
  inApp = true;
  $("user-email").textContent = user.email;
  show("app");
  closeSidebar();
  chat.start();
  applyUsage(usage);
  $("input").focus();
}

setUnauthorizedHandler(() => {
  if (inApp) showAuth("Сессия закончилась. Войдите снова.");
});

async function submitAuth({ errorEl, submitEl, path, body, clearFields }) {
  errorEl.hidden = true;
  submitEl.disabled = true;
  try {
    const data = await api("POST", path, body, { silent401: true });
    for (const field of clearFields) field.value = "";
    enterApp(data);
  } catch (failure) {
    errorEl.textContent = failure.message;
    errorEl.hidden = false;
  } finally {
    submitEl.disabled = false;
  }
}

$("login-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const email = $("login-email").value.trim();
  const password = $("login-password").value;
  if (!email || !password) {
    $("login-error").textContent = "Введите email и пароль.";
    $("login-error").hidden = false;
    return;
  }
  void submitAuth({ errorEl: $("login-error"), submitEl: $("login-submit"), path: "/api/auth/login", body: { email, password }, clearFields: [$("login-password")] });
});

$("register-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const inviteCode = $("register-code").value.trim();
  const email = $("register-email").value.trim();
  const password = $("register-password").value;
  const error = $("register-error");
  if (!inviteCode || !email || !password) {
    error.textContent = "Заполните все поля.";
    error.hidden = false;
    return;
  }
  if (password.length < 10) {
    error.textContent = "Пароль: минимум 10 символов.";
    error.hidden = false;
    return;
  }
  void submitAuth({
    errorEl: error,
    submitEl: $("register-submit"),
    path: "/api/auth/register",
    body: { email, password, inviteCode },
    clearFields: [$("register-password"), $("register-code")],
  });
});

$("logout").addEventListener("click", async () => {
  try {
    await api("POST", "/api/auth/logout", undefined, { silent401: true });
  } catch {
    // Выходим локально в любом случае.
  }
  showAuth();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && inApp) void refreshUsage();
});

/* ---------- старт ---------- */
(async () => {
  try {
    enterApp(await api("GET", "/api/me", undefined, { silent401: true }));
  } catch (error) {
    if (error.status === 401) showAuth();
    else {
      show("auth");
      setMode("login");
      $("login-error").textContent = error.message;
      $("login-error").hidden = false;
    }
  }
})();
