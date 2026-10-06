/** Ошибка с кодом и текстом, безопасным для показа пользователю. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
    /** Когда снимется ограничение (ISO-время) — для лимитов, чтобы интерфейс показал таймер. */
    public readonly resetsAt?: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const errors = {
  unauthorized: (message = "Нужно войти в аккаунт.") => new AppError("unauthorized", message, 401),
  forbidden: (message = "Недостаточно прав.") => new AppError("forbidden", message, 403),
  invalid: (message = "Некорректные данные запроса.") => new AppError("invalid_request", message, 400),
  unavailable: () => new AppError("upstream_unavailable", "Сервис временно недоступен. Попробуйте чуть позже.", 502),
  misconfigured: () => new AppError("upstream_misconfigured", "Сервис временно недоступен (ошибка настройки). Мы уже знаем об этом.", 502),
  invalidUpstream: () => new AppError("upstream_invalid", "Сервис временно недоступен (несовместимые версии). Мы уже знаем об этом.", 502),
};
