# ENTINEQ (powered by Claude)

Публичное веб-приложение для всех остальных пользователей: вход и регистрация по приглашению, чат с Claude, история диалогов, индикатор лимита сессии с таймером. Отвечает на запросы, но своего агента, ключа и базы не имеет: промпты уходят в бэкенд [ENTINEQ_AGENT](../ENTINEQ_AGENT), а Claude видит только его.

Состоит из двух самостоятельных проектов - у каждого свой репозиторий, `Dockerfile` и сервис в Railway:

| Папка | Что это | README |
|---|---|---|
| [`backend/`](backend) | Тонкий бэкенд: проверяет ввод, ставит cookie входа, пересылает запросы и чат в бэкенд ENTINEQ_AGENT. Ни БД, ни ключей. | [backend/README.md](backend/README.md) |
| [`frontend/`](frontend) | Страницы (вход, регистрация, чат) и пересылка `/api` и `/ws` на бэкенд по адресу `BACKEND_URL`. | [frontend/README.md](frontend/README.md) |

Связь: `frontend` → `backend` через `BACKEND_URL` во фронтенде и `ALLOWED_ORIGINS` в бэкенде; `backend` → бэкенд ENTINEQ_AGENT через `AGENT_BASE_URL` и общий секрет `INTERNAL_API_SECRET`. Схема и порядок деплоя - в [общем README](../README.md).
