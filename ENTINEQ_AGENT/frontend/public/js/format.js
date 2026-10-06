const pad = (n) => String(n).padStart(2, "0");

export function fmtUsd(value) {
  const n = Number(value) || 0;
  return `$${n !== 0 && Math.abs(n) < 0.01 ? n.toFixed(4) : n.toFixed(2)}`;
}

/** Обратный отсчёт: Ч:ММ:СС, а если больше двух суток - в днях. */
export function fmtCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  if (total >= 48 * 3600) return `${Math.ceil(total / 86400)} дн.`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${pad(m)}:${pad(s)}`;
}

export function fmtDateTime(iso) {
  return iso ? new Date(iso).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }) : "-";
}

export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(v);
}

/** Когда и почему сейчас нельзя писать (по данным о лимитах), либо null. */
export function blockFromUsage(usage) {
  if (!usage) return null;
  if (usage.monthBudgetUsd !== null && usage.monthSpentUsd >= usage.monthBudgetUsd) {
    return {
      kind: "month",
      resetsAt: new Date(usage.monthResetsAt).getTime(),
      text: `Месячный лимит исчерпан (${fmtUsd(usage.monthSpentUsd)} из ${fmtUsd(usage.monthBudgetUsd)}).`,
    };
  }
  const w = usage.window;
  if (w.limitUsd !== null) {
    if (w.active && w.spentUsd >= w.limitUsd) {
      return {
        kind: "window",
        resetsAt: new Date(w.resetsAt).getTime(),
        text: `Лимит сессии исчерпан (${fmtUsd(w.spentUsd)} из ${fmtUsd(w.limitUsd)}).`,
      };
    }
    if (w.limitUsd <= 0) return { kind: "zero", resetsAt: null, text: "Для вашего аккаунта лимит сессии равен нулю. Обратитесь к администратору." };
  }
  return null;
}
