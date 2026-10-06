import { $ } from "./dom.js";
import { fmtCountdown, fmtUsd } from "./format.js";

/**
 * Панель «Лимит сессии»: сколько потрачено в текущем окне и сколько осталось до его сброса.
 * Окно (как 5-часовой лимит у подписок) стартует с первого сообщения; таймер идёт от этого момента.
 */
export function createUsagePanel({ onTick, onExpire }) {
  const hoursEl = $("usage-hours");
  const barEl = $("usage-bar");
  const fillEl = $("usage-bar-fill");
  const windowLine = $("usage-window-line");
  const timerEl = $("usage-timer");
  const monthLine = $("usage-month-line");

  let usage = null;
  let expiredReported = false;
  let interval = null;

  function render() {
    if (!usage) return;
    const w = usage.window;
    hoursEl.textContent = `(${w.hours} ч)`;

    if (w.limitUsd === null) {
      barEl.hidden = true;
      windowLine.classList.remove("strong");
      windowLine.textContent = `В этом окне: ${fmtUsd(w.spentUsd)} · без лимита`;
    } else {
      barEl.hidden = false;
      const ratio = w.limitUsd > 0 ? Math.min(1, w.spentUsd / w.limitUsd) : 1;
      fillEl.style.width = `${Math.round(ratio * 100)}%`;
      // Цвет только для отказа: полоса красная, когда лимит исчерпан. Приближение к лимиту (80 процентов и больше) - весом строки.
      fillEl.className = `bar-fill${ratio >= 1 ? " danger" : ""}`;
      windowLine.classList.toggle("strong", ratio >= 0.8);
      windowLine.textContent = `${fmtUsd(w.spentUsd)} из ${fmtUsd(w.limitUsd)}`;
    }

    if (w.active && w.resetsAt) {
      const left = Date.parse(w.resetsAt) - Date.now();
      timerEl.textContent = left > 0 ? `Сброс через ${fmtCountdown(left)}` : "Окно закончилось, обновляю…";
      if (left <= 0 && !expiredReported) {
        expiredReported = true;
        onExpire();
      }
    } else {
      timerEl.textContent = "Окно начнётся с вашего первого сообщения";
    }

    monthLine.textContent =
      usage.monthBudgetUsd === null
        ? `Месяц: ${fmtUsd(usage.monthSpentUsd)} · без лимита`
        : `Месяц: ${fmtUsd(usage.monthSpentUsd)} из ${fmtUsd(usage.monthBudgetUsd)}`;
  }

  function ensureTimer() {
    if (interval === null) {
      interval = setInterval(() => {
        render();
        onTick();
      }, 1000);
    }
  }

  return {
    update(next) {
      usage = next;
      expiredReported = false;
      render();
      ensureTimer();
    },
    stop() {
      if (interval !== null) clearInterval(interval);
      interval = null;
      usage = null;
    },
  };
}
