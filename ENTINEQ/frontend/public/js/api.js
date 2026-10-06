export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let onUnauthorized = () => {};

/** Что делать, когда сервер ответил «нужно войти» на запрос внутри приложения. */
export function setUnauthorizedHandler(handler) {
  onUnauthorized = handler;
}

export async function api(method, path, body, { silent401 = false } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network", "Нет связи с сервером. Проверьте подключение.");
  }
  if (response.status === 204) return null;
  let data = null;
  try {
    data = await response.json();
  } catch {
    // тело не JSON — сообщение возьмём из статуса
  }
  if (!response.ok) {
    const error = data && data.error ? data.error : {};
    const apiError = new ApiError(response.status, error.code || "error", error.message || `Ошибка ${response.status}`, error);
    if (response.status === 401 && !silent401) onUnauthorized(apiError);
    throw apiError;
  }
  return data;
}
