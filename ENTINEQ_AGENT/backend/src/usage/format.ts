/** «3 ч 20 мин», «45 мин», «5 дн.»: сколько осталось до сброса лимита (для текстов ошибок). */
export function humanDuration(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes >= 48 * 60) return `${Math.ceil(minutes / (24 * 60))} дн.`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h} ч ${m} мин`;
  return h ? `${h} ч` : `${m} мин`;
}

export const money = (value: number) => `$${value < 0.01 && value > 0 ? value.toFixed(4) : value.toFixed(2)}`;
