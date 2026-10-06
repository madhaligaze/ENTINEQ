import { api } from "./api.js";
import { clear, el } from "./dom.js";
import { fmtDateTime, fmtTokens, fmtUsd } from "./format.js";

const ROLE_LABEL = { owner: "владелец", trusted: "доверенный", public: "публичный" };
const STATUS_LABEL = { active: "действует", used: "использовано", revoked: "отозвано", expired: "истекло" };

/** Пустое поле - «не задано» (null), иначе неотрицательное число. */
function readMoney(input, label) {
  const raw = input.value.trim().replace(",", ".");
  if (raw === "") return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label}: нужно неотрицательное число или пустое поле.`);
  return value;
}

function field(label, input) {
  const id = `f-${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  return el("div", { class: "field" }, el("label", { for: id, text: label }), input);
}

function table(headers, rows, footer) {
  return el(
    "div",
    { class: "table-wrap" },
    el(
      "table",
      {},
      el("thead", {}, el("tr", {}, headers.map((h) => el("th", { class: h.num ? "num" : "", text: h.text })))),
      el("tbody", {}, rows),
      footer ? el("tfoot", {}, footer) : null,
    ),
  );
}

const csvCell = (value) => {
  const text = String(value);
  return /[";\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export function mountAdmin(root) {
  const flash = el("div", { class: "notice", role: "status", hidden: true });
  let flashTimer = null;
  const notify = (text, isError = false) => {
    flash.textContent = text;
    flash.className = isError ? "notice error" : "notice";
    flash.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (flash.hidden = true), 7000);
  };
  const guard = (fn) => async () => {
    try {
      await fn();
    } catch (error) {
      notify(error.message, true);
    }
  };

  const usersBox = el("div");
  const invitesBox = el("div");
  const reportBox = el("div");

  /* ---------- пользователи ---------- */
  async function loadUsers() {
    const { users } = await api("GET", "/api/admin/users");
    clear(usersBox);
    usersBox.append(
      table(
        [{ text: "Email" }, { text: "Роль" }, { text: "Статус" }, { text: "Месяц, $", num: true }, { text: "Лимит в месяц, $" }, { text: "Лимит окна, $" }, { text: "" }],
        users.map(userRow),
      ),
    );
  }

  function userRow(user) {
    const monthly = el("input", { type: "number", min: "0", step: "0.01", value: user.monthlyBudgetUsd ?? "", placeholder: "без лимита", "aria-label": `Месячный лимит: ${user.email}` });
    const windowLimit = el("input", { type: "number", min: "0", step: "0.01", value: user.windowLimitUsd ?? "", placeholder: "без лимита", "aria-label": `Лимит окна: ${user.email}` });

    const save = el("button", {
      type: "button",
      text: "Сохранить",
      onclick: guard(async () => {
        await api("PATCH", `/api/admin/users/${user.id}`, {
          monthlyBudgetUsd: readMoney(monthly, "Лимит в месяц"),
          windowLimitUsd: readMoney(windowLimit, "Лимит окна"),
        });
        notify(`Лимиты сохранены: ${user.email}`);
        await loadUsers();
      }),
    });

    const toggle =
      user.role === "owner"
        ? null
        : el("button", {
            type: "button",
            text: user.isActive ? "Отключить" : "Включить",
            onclick: guard(async () => {
              await api("PATCH", `/api/admin/users/${user.id}`, { isActive: !user.isActive });
              notify(user.isActive ? `Отключён: ${user.email}` : `Включён: ${user.email}`);
              await loadUsers();
            }),
          });

    const passwordCell = el("span");
    const showPasswordButton = () => {
      clear(passwordCell);
      passwordCell.append(el("button", { type: "button", text: "Пароль…", onclick: showPasswordForm }));
    };
    const showPasswordForm = () => {
      const input = el("input", { type: "password", placeholder: "новый пароль", autocomplete: "new-password", "aria-label": `Новый пароль: ${user.email}`, minlength: "10" });
      clear(passwordCell);
      passwordCell.append(
        input,
        el("button", {
          type: "button",
          text: "Сменить",
          onclick: guard(async () => {
            await api("PATCH", `/api/admin/users/${user.id}`, { password: input.value });
            notify(`Пароль изменён, старые входы закрыты: ${user.email}`);
            showPasswordButton();
          }),
        }),
        el("button", { type: "button", class: "ghost", text: "×", "aria-label": "Отмена", onclick: showPasswordButton }),
      );
      input.focus();
    };
    showPasswordButton();

    return el(
      "tr",
      {},
      el("td", { text: user.email }),
      el("td", {}, el("span", { class: "badge", text: ROLE_LABEL[user.role] ?? user.role })),
      // Цвет только для отказа: «активен» остаётся нейтральным, «отключён» красным.
      el("td", {}, el("span", { class: user.isActive ? "badge" : "badge off", text: user.isActive ? "активен" : "отключён" })),
      el("td", { class: "num", text: fmtUsd(user.spentThisMonthUsd) }),
      el("td", {}, monthly),
      el("td", {}, windowLimit),
      el("td", {}, el("div", { class: "row" }, save, toggle, passwordCell)),
    );
  }

  const createUserForm = (() => {
    const email = el("input", { type: "email", required: true, autocomplete: "off" });
    const password = el("input", { type: "password", required: true, minlength: "10", autocomplete: "new-password" });
    const role = el("select", {}, el("option", { value: "trusted", text: "доверенный (терминал и файлы)" }), el("option", { value: "public", text: "публичный (только чат)" }));
    const monthly = el("input", { type: "number", min: "0", step: "0.01", placeholder: "по умолчанию" });
    const windowLimit = el("input", { type: "number", min: "0", step: "0.01", placeholder: "по умолчанию" });
    const submit = el("button", { type: "submit", class: "primary", text: "Создать" });
    const form = el(
      "form",
      { class: "row" },
      field("Email", email),
      field("Пароль (от 10 символов)", password),
      field("Роль", role),
      field("Лимит в месяц, $", monthly),
      field("Лимит окна, $", windowLimit),
      submit,
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void guard(async () => {
        const body = { email: email.value.trim(), password: password.value, role: role.value };
        const m = readMoney(monthly, "Лимит в месяц");
        const w = readMoney(windowLimit, "Лимит окна");
        if (m !== null) body.monthlyBudgetUsd = m;
        if (w !== null) body.windowLimitUsd = w;
        await api("POST", "/api/admin/users", body);
        notify(`Создан пользователь ${body.email}`);
        form.reset();
        await loadUsers();
      })();
    });
    return form;
  })();

  /* ---------- приглашения ---------- */
  const codesBox = el("textarea", { class: "codes", readonly: true, rows: "3", "aria-label": "Новые коды приглашений" });
  const codesWrap = el("div", { hidden: true }, el("p", { class: "muted", text: "Сохраните коды сейчас: показываются один раз, дальше в системе хранится только их хеш." }), codesBox, el("button", { type: "button", text: "Скопировать", onclick: copyCodes }));

  async function copyCodes() {
    try {
      await navigator.clipboard.writeText(codesBox.value);
      notify("Коды скопированы");
    } catch {
      codesBox.select();
      notify("Выделено - нажмите Ctrl+C");
    }
  }

  const createInviteForm = (() => {
    const count = el("input", { type: "number", min: "1", max: "50", value: "1" });
    const days = el("input", { type: "number", min: "1", max: "90", value: "14" });
    const monthly = el("input", { type: "number", min: "0", step: "0.01", placeholder: "по умолчанию" });
    const windowLimit = el("input", { type: "number", min: "0", step: "0.01", placeholder: "по умолчанию" });
    const form = el(
      "form",
      { class: "row" },
      field("Сколько кодов", count),
      field("Действуют, дней", days),
      field("Лимит в месяц, $", monthly),
      field("Лимит окна, $", windowLimit),
      el("button", { type: "submit", class: "primary", text: "Создать приглашения" }),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void guard(async () => {
        const body = { count: Number(count.value), expiresInDays: Number(days.value) };
        const m = readMoney(monthly, "Лимит в месяц");
        const w = readMoney(windowLimit, "Лимит окна");
        if (m !== null) body.monthlyBudgetUsd = m;
        if (w !== null) body.windowLimitUsd = w;
        const { invites } = await api("POST", "/api/admin/invites", body);
        codesBox.value = invites.map((invite) => invite.code).join("\n");
        codesBox.rows = String(Math.min(10, Math.max(3, invites.length)));
        codesWrap.hidden = false;
        notify(`Создано приглашений: ${invites.length}`);
        await loadInvites();
      })();
    });
    return form;
  })();

  async function loadInvites() {
    const { invites } = await api("GET", "/api/admin/invites");
    clear(invitesBox);
    if (!invites.length) {
      invitesBox.append(el("p", { class: "muted", text: "Приглашений пока нет." }));
      return;
    }
    invitesBox.append(
      table(
        [{ text: "Код" }, { text: "Статус" }, { text: "Лимит в месяц" }, { text: "Лимит окна" }, { text: "Действует до" }, { text: "Кто использовал" }, { text: "" }],
        invites.map((invite) =>
          el(
            "tr",
            {},
            el("td", { text: `ENT-••••-••••-${invite.codeHint}` }),
            el("td", {}, el("span", { class: "badge", text: STATUS_LABEL[invite.status] ?? invite.status })),
            el("td", { text: invite.monthlyBudgetUsd === null ? "без лимита" : fmtUsd(invite.monthlyBudgetUsd) }),
            el("td", { text: invite.windowLimitUsd === null ? "без лимита" : fmtUsd(invite.windowLimitUsd) }),
            el("td", { text: fmtDateTime(invite.expiresAt) }),
            el("td", { text: invite.usedByEmail ?? "-" }),
            el(
              "td",
              {},
              invite.status === "active"
                ? el("button", {
                    type: "button",
                    text: "Отозвать",
                    onclick: guard(async () => {
                      await api("DELETE", `/api/admin/invites/${invite.id}`);
                      notify("Приглашение отозвано");
                      await loadInvites();
                    }),
                  })
                : null,
            ),
          ),
        ),
      ),
    );
  }

  /* ---------- расходы ---------- */
  const monthInput = el("input", { type: "month", value: new Date().toISOString().slice(0, 7), "aria-label": "Месяц отчёта" });
  let lastReport = null;

  async function loadReport() {
    const month = monthInput.value || new Date().toISOString().slice(0, 7);
    const report = await api("GET", `/api/admin/usage?month=${encodeURIComponent(month)}`);
    lastReport = report;
    clear(reportBox);
    reportBox.append(
      table(
        [{ text: "Пользователь" }, { text: "Роль" }, { text: "Запросов", num: true }, { text: "Вход", num: true }, { text: "Выход", num: true }, { text: "Кэш (чтение)", num: true }, { text: "К оплате", num: true }],
        report.users.map((row) =>
          el(
            "tr",
            {},
            el("td", { text: row.email }),
            el("td", { text: ROLE_LABEL[row.role] ?? row.role }),
            el("td", { class: "num", text: String(row.turns) }),
            el("td", { class: "num", text: fmtTokens(row.inputTokens) }),
            el("td", { class: "num", text: fmtTokens(row.outputTokens) }),
            el("td", { class: "num", text: fmtTokens(row.cacheReadTokens) }),
            el("td", { class: "num", text: fmtUsd(row.costUsd) }),
          ),
        ),
        el("tr", {}, el("td", { colspan: "6", text: `Итого за ${report.month}` }), el("td", { class: "num", text: fmtUsd(report.totalUsd) })),
      ),
    );
  }

  function downloadCsv() {
    if (!lastReport) return;
    const header = ["email", "role", "turns", "input_tokens", "output_tokens", "cache_read_tokens", "cache_creation_tokens", "cost_usd"];
    const lines = [header.join(";")];
    for (const row of lastReport.users) {
      lines.push([row.email, row.role, row.turns, row.inputTokens, row.outputTokens, row.cacheReadTokens, row.cacheCreationTokens, row.costUsd.toFixed(6)].map(csvCell).join(";"));
    }
    lines.push(["ИТОГО", "", "", "", "", "", "", lastReport.totalUsd.toFixed(6)].join(";"));
    // BOM нужен, чтобы Excel правильно прочитал кириллицу.
    const blob = new Blob([`﻿${lines.join("\r\n")}`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = el("a", { href: url, download: `entineq-usage-${lastReport.month}.csv` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* ---------- сборка ---------- */
  root.append(
    flash,
    el("section", {}, el("h2", { text: "Пользователи" }), usersBox),
    el(
      "section",
      {},
      el("h2", { text: "Создать пользователя" }),
      el("p", { class: "muted", text: "Пустое поле лимита - значение по умолчанию для роли. Безлимитным пользователя можно сделать в таблице выше, очистив поле." }),
      createUserForm,
    ),
    el(
      "section",
      {},
      el("h2", { text: "Приглашения для публичного приложения ENTINEQ" }),
      el("p", { class: "muted", text: "Регистрация в публичном приложении - только по коду. Код одноразовый, лимиты берутся из приглашения." }),
      createInviteForm,
      codesWrap,
      invitesBox,
    ),
    el(
      "section",
      {},
      el("h2", { text: "Расходы за месяц (по UTC)" }),
      el(
        "p",
        { class: "muted", text: "Суммы считаются по данным Claude Agent SDK и являются оценкой, а не счётом Anthropic. Для сверки сравните «Итого» с разделом Usage в консоли Anthropic." },
      ),
      el(
        "div",
        { class: "row" },
        field("Месяц", monthInput),
        el("button", { type: "button", text: "Показать", onclick: guard(loadReport) }),
        el("button", { type: "button", text: "Скачать CSV", onclick: downloadCsv }),
      ),
      reportBox,
    ),
  );

  return {
    load: guard(async () => {
      await Promise.all([loadUsers(), loadInvites(), loadReport()]);
    }),
  };
}
