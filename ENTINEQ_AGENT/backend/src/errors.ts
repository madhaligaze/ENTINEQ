/** Ошибка с кодом и текстом, безопасным для показа пользователю. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    /** Когда снимется ограничение (ISO-время) - для лимитов, чтобы интерфейс показал таймер. */
    public readonly resetsAt?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const errors = {
  unauthorized: (message = "Нужно войти в аккаунт.") => new AppError("unauthorized", message, 401),
  forbidden: (message = "Недостаточно прав.") => new AppError("forbidden", message, 403),
  notFound: (message = "Не найдено.") => new AppError("not_found", message, 404),
  invalid: (message = "Некорректные данные запроса.") => new AppError("invalid_request", message, 400),
  conflict: (code: string, message: string) => new AppError(code, message, 409),
};

/** Ищет код ошибки Postgres по цепочке cause (drizzle оборачивает ошибки драйвера). */
export function pgErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export const isUniqueViolation = (error: unknown) => pgErrorCode(error) === "23505";

/** Вырезает из текста всё, что похоже на секреты (ключи Anthropic, Bearer-токены). */
export function redactSecrets(text: string): string {
  return text
    .replace(/sk-ant-[A-Za-z0-9_-]{8,}/g, "sk-ant-***")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer ***");
}
