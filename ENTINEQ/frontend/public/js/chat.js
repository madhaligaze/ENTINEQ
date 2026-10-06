import { api } from "./api.js";
import { clear, el } from "./dom.js";

const RECONNECT_MAX_MS = 15000;

/** Разбирает сохранённую строку инструмента «Имя: описание». */
function parseTool(content) {
  const at = content.indexOf(": ");
  return at === -1 ? { name: "Tool", summary: content } : { name: content.slice(0, at), summary: content.slice(at + 2) };
}

/**
 * Чат: WebSocket с переподключением, потоковый ответ, история диалогов.
 * Весь текст попадает на страницу через textContent — вставить разметку или скрипт в ответ невозможно.
 */
export class Chat {
  constructor(options) {
    this.o = options;
    this.ws = null;
    this.currentId = null;
    this.busy = false;
    this.blocked = false;
    this.connected = false;
    this.live = null;
    this.retries = 0;
    this.openedAt = 0;
    this.stopped = true;
    this.reconnectTimer = null;
    this.busyWhenClosed = false;
    this.items = [];
    this.#wire();
  }

  #wire() {
    this.o.composer.addEventListener("submit", (event) => {
      event.preventDefault();
      this.#submit();
    });
    this.o.input.addEventListener("keydown", (event) => {
      // Enter отправляет, Shift+Enter — новая строка; во время ввода через IME Enter не трогаем.
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        this.#submit();
      }
    });
    this.o.newButton.addEventListener("click", () => this.newConversation());
    this.o.list.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-id]");
      if (button) this.openConversation(button.dataset.id);
    });
  }

  start() {
    this.stopped = false;
    this.retries = 0;
    this.reset();
    this.#connect();
    this.refreshList();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.ws = null;
    this.connected = false;
    if (ws) ws.close();
    this.reset();
  }

  reset() {
    this.currentId = null;
    this.busy = false;
    this.live = null;
    this.items = [];
    clear(this.o.messages);
    clear(this.o.list);
    this.o.onToolsReset();
    this.#showHint();
    this.#sync();
  }

  setBlocked(blocked) {
    this.blocked = blocked;
    this.#sync();
  }

  #connect() {
    clearTimeout(this.reconnectTimer);
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${protocol}//${location.host}${this.o.wsPath}`);
    this.ws = ws;
    this.#setStatus("подключение…");

    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.connected = true;
      this.openedAt = Date.now();
      // Паузу между попытками здесь не сбрасываем: сервер мог принять соединение и сразу закрыть его
      // (ядро недоступно) — тогда пауза должна продолжать расти, а не долбить сервер раз в секунду.
      this.#setStatus("готов");
      this.#sync();
      if (this.busyWhenClosed) {
        // Соединение оборвалось посреди ответа: сервер дописал его сам, подтягиваем сохранённое.
        this.busyWhenClosed = false;
        if (this.currentId) setTimeout(() => this.openConversation(this.currentId, { quiet: true }), 1500);
      }
    });
    ws.addEventListener("message", (event) => {
      if (this.ws === ws) this.#onMessage(event.data);
    });
    ws.addEventListener("close", (event) => {
      if (this.ws !== ws) return;
      this.connected = false;
      // Соединение прожило достаточно долго — считаем его удачным и начинаем отсчёт пауз заново.
      if (this.openedAt && Date.now() - this.openedAt > 5000) this.retries = 0;
      this.openedAt = 0;
      if (this.busy) {
        this.busyWhenClosed = true;
        this.busy = false;
        this.live = null;
      }
      this.#sync();
      if (event.code === 4401) {
        this.stopped = true;
        this.o.onAuthLost();
        return;
      }
      if (!this.stopped) this.#scheduleReconnect();
    });
  }

  #scheduleReconnect() {
    const delay = Math.min(RECONNECT_MAX_MS, 1000 * 2 ** this.retries);
    this.retries += 1;
    this.#setStatus(`нет соединения, повтор через ${Math.round(delay / 1000)} с…`);
    this.reconnectTimer = setTimeout(() => this.#connect(), delay);
  }

  #onMessage(raw) {
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    switch (event.kind) {
      case "conversation":
        this.currentId = event.id;
        this.#highlight();
        break;
      case "delta":
        this.#liveBubble().textContent += event.text;
        this.#scroll();
        break;
      case "text":
        // Итоговый текст блока заменяет то, что накопилось из кусочков.
        this.#liveBubble().textContent = event.text;
        this.live = null;
        this.#scroll();
        break;
      case "tool":
        this.live = null;
        this.o.onTool(event);
        break;
      case "usage":
        this.o.onUsage(event.usage);
        break;
      case "error":
        // Ошибка хода остаётся в переписке; ошибки соединения (когда ход не шёл) — только в баннере, без шума в чате.
        if (this.busy) {
          this.#clearHint();
          this.#bubble("system", `⚠ ${event.message}`);
          this.#scroll();
        }
        this.o.onError(event.message);
        break;
      case "done":
        this.busy = false;
        this.live = null;
        this.#setStatus("готов");
        this.#sync();
        this.refreshList();
        break;
      default:
        break;
    }
  }

  #submit() {
    const text = this.o.input.value.trim();
    if (text && this.send(text)) this.o.input.value = "";
  }

  send(text) {
    if (this.busy || this.blocked) return false;
    if (!this.connected || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.o.onError("Нет соединения с сервером. Идёт переподключение…");
      return false;
    }
    this.#clearHint();
    this.#bubble("user", text);
    this.busy = true;
    this.live = null;
    this.ws.send(JSON.stringify({ type: "user", text, ...(this.currentId ? { conversationId: this.currentId } : {}) }));
    this.#setStatus("агент работает…");
    this.#sync();
    this.#scroll(true);
    return true;
  }

  async openConversation(id, { quiet = false } = {}) {
    if (this.busy) return;
    try {
      const data = await api("GET", `${this.o.apiBase}/conversations/${id}/messages`);
      if (this.busy) return;
      this.currentId = id;
      this.live = null;
      clear(this.o.messages);
      this.o.onToolsReset();
      for (const message of data.messages) {
        if (message.role === "tool") this.o.onTool(parseTool(message.content));
        else this.#bubble(message.role === "user" ? "user" : "assistant", message.content);
      }
      if (!data.messages.length) this.#showHint();
      this.#highlight();
      this.#scroll(true);
      if (!quiet) this.o.onOpened();
    } catch (error) {
      this.o.onError(error.message);
    }
  }

  newConversation() {
    if (this.busy) return;
    this.currentId = null;
    this.live = null;
    clear(this.o.messages);
    this.o.onToolsReset();
    this.#showHint();
    this.#highlight();
    this.o.onOpened();
    this.o.input.focus();
  }

  async refreshList() {
    try {
      const data = await api("GET", `${this.o.apiBase}/conversations`, undefined, { silent401: true });
      this.items = data.conversations;
      this.#renderList();
    } catch {
      // Список диалогов не критичен: при ошибке просто оставляем прежний.
    }
  }

  #renderList() {
    clear(this.o.list);
    if (!this.items.length) {
      this.o.list.append(el("li", { class: "empty", text: "Диалогов пока нет" }));
      return;
    }
    for (const item of this.items) {
      this.o.list.append(
        el("li", {}, el("button", { type: "button", "data-id": item.id, title: item.title, class: item.id === this.currentId ? "active" : "", text: item.title })),
      );
    }
  }

  #highlight() {
    for (const button of this.o.list.querySelectorAll("button[data-id]")) {
      button.classList.toggle("active", button.dataset.id === this.currentId);
    }
  }

  #bubble(role, text) {
    const node = el("div", { class: `bubble ${role}`, text });
    this.o.messages.append(node);
    return node;
  }

  #liveBubble() {
    this.#clearHint();
    if (!this.live) this.live = this.#bubble("assistant", "");
    return this.live;
  }

  #showHint() {
    if (!this.o.messages.querySelector(".hint")) this.o.messages.append(el("div", { class: "hint", text: this.o.hint }));
  }

  #clearHint() {
    this.o.messages.querySelector(".hint")?.remove();
  }

  #scroll(force = false) {
    const box = this.o.messages;
    if (force || box.scrollHeight - box.scrollTop - box.clientHeight < 140) box.scrollTop = box.scrollHeight;
  }

  #setStatus(text) {
    this.o.status.textContent = text;
  }

  #sync() {
    const canSend = this.connected && !this.busy && !this.blocked;
    this.o.send.disabled = !canSend;
    this.o.input.placeholder = this.blocked ? "Лимит исчерпан — дождитесь сброса" : this.o.placeholder;
  }
}
