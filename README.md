# ENTINEQ

Продукт на [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview): два веб-приложения, каждое из фронтенда и бэкенда. В Railway это **пять сервисов**: четыре из отдельных репозиториев GitHub плюс PostgreSQL. Сервисы деплоятся независимо и связаны переменными окружения.

```
ENTINEQ/                         (эта папка - только для разработки; в Railway её нет)
├── ENTINEQ_AGENT/               веб-приложение №1: для владельца и доверенных; одновременно бэкенд для публичного
│   ├── backend/                 репозиторий 1 - аккаунты, лимиты, учёт, агент на Claude Agent SDK, БД
│   └── frontend/                репозиторий 2 - страницы + пересылка /api и /ws на бэкенд
├── ENTINEQ/                     веб-приложение №2: публичное («ENTINEQ powered by Claude»)
│   ├── backend/                 репозиторий 3 - тонкий бэкенд: вход, cookie, пересылка в бэкенд ENTINEQ_AGENT
│   └── frontend/                репозиторий 4 - страницы + пересылка /api и /ws на бэкенд
├── e2e/                         сквозные тесты в браузере (вне репозиториев)
└── docker-compose.yml           вся связка локально одной командой (вне репозиториев)
```

```
Браузер ──▶ ENTINEQ frontend ──▶ ENTINEQ backend ──▶ ENTINEQ_AGENT backend ──▶ Claude API
                                                          ▲        └──▶ PostgreSQL
Браузер ──▶ ENTINEQ_AGENT frontend ───────────────────────┘
```

Claude видит запросы только от бэкенда ENTINEQ_AGENT и не знает, откуда пришёл промпт: из собственного интерфейса или через публичное приложение.

**Ключ Anthropic, база данных, аккаунты, лимиты и учёт расходов - только в бэкенде ENTINEQ_AGENT.** Публичное приложение их не имеет: даже при его взломе красть нечего. Права определяет «дверь», через которую пришёл запрос: из публичного приложения агент получает только чат без инструментов.

## Railway: пять сервисов

Всё в **одном проекте Railway** (так работает внутренняя сеть и ссылки между сервисами, как в вашем примере с KORT). Имена сервисов ниже - предложение; если назовёте иначе, поправьте ссылки `${{…}}`.

| Сервис | Репозиторий | Публичный домен | Переменные |
|---|---|---|---|
| **Postgres** | плагин Railway | нет | - |
| **entineq-agent-backend** | `ENTINEQ_AGENT/backend` | **не нужен** | `DATABASE_URL` = `${{Postgres.DATABASE_URL}}`<br>`ANTHROPIC_API_KEY`<br>`INTERNAL_API_SECRET` (общий секрет)<br>`OWNER_EMAIL`, `OWNER_PASSWORD`<br>`ALLOWED_ORIGINS` = `https://${{entineq-agent-frontend.RAILWAY_PUBLIC_DOMAIN}}`<br>`PORT` = `8080` |
| **entineq-agent-frontend** | `ENTINEQ_AGENT/frontend` | да | `BACKEND_URL` = `http://${{entineq-agent-backend.RAILWAY_PRIVATE_DOMAIN}}:${{entineq-agent-backend.PORT}}` |
| **entineq-backend** | `ENTINEQ/backend` | **не нужен** | `AGENT_BASE_URL` = `http://${{entineq-agent-backend.RAILWAY_PRIVATE_DOMAIN}}:${{entineq-agent-backend.PORT}}`<br>`INTERNAL_API_SECRET` (**тот же**)<br>`ALLOWED_ORIGINS` = `https://${{entineq-frontend.RAILWAY_PUBLIC_DOMAIN}}`<br>`PORT` = `8080` |
| **entineq-frontend** | `ENTINEQ/frontend` | да | `BACKEND_URL` = `http://${{entineq-backend.RAILWAY_PRIVATE_DOMAIN}}:${{entineq-backend.PORT}}` |

Порядок: Postgres → агент-бэкенд → два фронтенда → публичный бэкенд. Общий секрет сгенерируйте командой `pnpm gen:secret` (в любом из бэкендов) и впишите **одно и то же значение** в оба бэкенда. Домены фронтендов создайте (**Settings → Networking → Generate Domain**) *до* того, как заполните `ALLOWED_ORIGINS`: ссылка на `RAILWAY_PUBLIC_DOMAIN` появляется только с доменом, после этого бэкенды перезапустите.

Что важно знать:

- **Бэкендам публичный домен не нужен.** Пока они доступны только по внутренней сети, из интернета до них не достучаться: это и есть «закрытый контур». Наружу смотрят только два фронтенда.
- **Почему фронтенд пересылает запросы, а не браузер ходит на бэкенд напрямую.** Тогда у браузера один адрес на приложение: cookie входа остаются «своими» (иначе Safari и другие браузеры режут сторонние cookie), работает защита от CSRF, а бэкенд скрыт. Пересылка идёт по `BACKEND_URL`.
- **`ALLOWED_ORIGINS`** - публичный адрес фронтенда, который браузер присылает в заголовке `Origin`. Если у фронтенда свой домен (например `chat.example.com`), впишите и его (через запятую). Без совпадения вход отклоняется как «запрос с чужого сайта», а в логах бэкенда будет подсказка.
- **Если сервисы в разных проектах Railway**, внутренняя сеть между ними недоступна: используйте публичные `https://…up.railway.app` адреса в `BACKEND_URL`/`AGENT_BASE_URL`, дайте бэкендам публичный домен и задайте им `TRUST_PROXY_HOPS=2`.
- **Бэкенд ENTINEQ_AGENT работает в одной реплике** (уже закреплено в его `railway.json`).
- В каждом из четырёх репозиториев лежит свой `railway.json`: сборка по `Dockerfile` и проверка здоровья `/healthz`.

## Локально

Вся связка в контейнерах одной командой:

```bash
docker compose up --build
```

Ядро - http://localhost:8080 (владелец `owner@example.com` / `owner-password-123`), публичное - http://localhost:8081. По умолчанию вместо Claude отвечает заглушка; для настоящего создайте рядом файл `.env` с `AGENT_RUNNER=claude` и `ANTHROPIC_API_KEY=…`. Бэкенды наружу не публикуются.

По отдельности (для разработки, в четырёх терминалах; везде `pnpm install` и `cp .env.example .env`):

| Папка | Команда | Адрес |
|---|---|---|
| `ENTINEQ_AGENT/backend` | `pnpm dev` | :8080 |
| `ENTINEQ_AGENT/frontend` | `pnpm dev` | http://localhost:3000 |
| `ENTINEQ/backend` | `pnpm dev` | :8081 |
| `ENTINEQ/frontend` | `pnpm dev` | http://localhost:3001 |

## Как это проверялось

| Что | Результат |
|---|---|
| Тесты `ENTINEQ_AGENT/backend` (аккаунты, лимиты окна, учёт, приглашения, безопасность, WebSocket; встроенная БД и настоящий PostgreSQL) | 166 из 166 |
| Тесты `ENTINEQ_AGENT/frontend` и `ENTINEQ/frontend` (пересылка `/api` и `/ws`, заголовки, лимиты, сбои бэкенда) | по 49 из 49 |
| Тесты `ENTINEQ/backend` (с поддельным ядром, умеющим «ломаться») | 54 из 54 |
| Сквозные тесты в настоящем браузере (`e2e/`): интерфейс ENTINEQ_AGENT (бэкенд + фронтенд) | 57 из 57 |
| то же для цепочки ENTINEQ_AGENT backend → ENTINEQ backend → ENTINEQ frontend (регистрация, чат, лимит с таймером, отключение пользователя, падение и возврат ядра, утечки секретов, телефон) | 71 из 71 |
| Пять контейнеров через docker compose: бэкенды не опубликованы, перезапуск бэкенда и самой БД посреди работы | 17 из 17 |
| Оформление по правилам CLAUDE.md в браузере через `getComputedStyle`: оба фронтенда, тёмная и светлая тема, ширины 1440, 800 и 390 (скругления, зелёный цвет, горизонтальная прокрутка, видимость элементов, контраст, вес выбранного) и самопроверка самого аудита | 56 из 56 |

**Не проверено без вашего участия:** запросы к настоящему Claude (в проверках вместо него заглушка) и реальный деплой в Railway. Живую проверку SDK запустите один раз: `pnpm smoke:live -- --yes` в `ENTINEQ_AGENT/backend` (тратит несколько центов).

Папка `e2e/` - сценарии Playwright; запускаются вне репозиториев (чтобы не тянуть Playwright в проекты): `node e2e/core.e2e.cjs`, `full.e2e.cjs`, `compose.e2e.cjs` (после `docker compose up`), `cookie-secure.e2e.cjs`, `ui-style.e2e.cjs` (оформление по правилам CLAUDE.md). Нужны собранные проекты (`pnpm build` в каждом), PostgreSQL на порту 54329 (для всех, кроме compose) и глобально установленный Playwright. Скрипт `node e2e/check-sync.cjs` проверяет, что общие файлы четырёх репозиториев не разошлись, а `node e2e/check-style.cjs` - что нигде в рабочем каталоге нет длинного тире (правило из CLAUDE.md; внутри каждого репозитория то же делает тест `test/no-long-dash.test.ts`).

## Что общего между репозиториями

Репозитории самостоятельны и ничего друг от друга не импортируют, поэтому несколько небольших файлов намеренно **продублированы**:

- код сервиса пересылки в обоих фронтендах (`frontend/src`, `frontend/test`) - одинаков;
- модули интерфейса чата `public/js/{api,dom,format,usage,chat}.js` - одинаковы в обоих фронтендах;
- `listen.ts` - в обоих бэкендах;
- контракт внутреннего API: `ENTINEQ/backend/src/contract.ts` ↔ `ENTINEQ_AGENT/backend/src/routes/internal.ts` (версия сверяется на лету через `/readyz`).

Правите такой файл в одном месте - перенесите в остальные и запустите `node e2e/check-sync.cjs`.
