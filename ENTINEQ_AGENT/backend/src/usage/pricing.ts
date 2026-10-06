/**
 * Прейскурант для оценки стоимости запросов, которые сервис делает сам (публичный чат через Messages API).
 * Цены в долларах за миллион токенов. Это оценка, а не счёт Anthropic: точные суммы - в консоли Anthropic.
 */
export interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  /** Запись в кэш на 5 минут (1.25 цены входа). */
  cacheWrite: number;
}

const RATES: Record<string, Rates> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

/** Для неизвестной модели берём самую дорогую ставку: лимиты сработают раньше, а не позже. */
const FALLBACK: Rates = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 };

export function isKnownModel(model: string): boolean {
  return normalizeModel(model) in RATES;
}

function normalizeModel(model: string): string {
  // Алиас с датой (claude-haiku-4-5-20251001) считается так же, как без даты.
  return model.replace(/-\d{8}$/, "");
}

export function ratesFor(model: string): Rates {
  return RATES[normalizeModel(model)] ?? FALLBACK;
}

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/** Стоимость в долларах (с точностью до 1e-8). */
export function costOf(model: string, tokens: TokenCounts): number {
  const rates = ratesFor(model);
  const dollars =
    (tokens.inputTokens * rates.input +
      tokens.outputTokens * rates.output +
      tokens.cacheReadInputTokens * rates.cacheRead +
      tokens.cacheCreationInputTokens * rates.cacheWrite) /
    1_000_000;
  return Math.round(dollars * 1e8) / 1e8;
}

/**
 * Грубая оценка числа токенов по длине текста - только для расчёта потолка длины ответа до запроса.
 * Два символа на токен: для английского это завышение (безопасная сторона), для русского близко к правде.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 2);
}
