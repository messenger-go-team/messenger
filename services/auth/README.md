# Auth

Реализация [#27](https://github.com/messenger-go-team/messenger/issues/27):
регистрация, вход, ротация refresh и выход по
[OpenAPI](../../api/openapi/auth.yaml) и [SPEC](../../docs/SPEC.md).
Схема PostgreSQL используется из миграций #12 без изменений.
Auth подключается через `pgx/stdlib`: отмена context прерывает сетевые операции
и при полной недоступности PostgreSQL; миграции сохраняют свой существующий драйвер.

## Запуск

Из корня репозитория подготовьте `.env` по `.env.example`, задайте собственный
пароль PostgreSQL, затем:

```bash
docker compose up -d --wait postgres
make migrate-up MIGRATE_SERVICE=auth
make build SERVICE=auth
export JWT_SECRET="$(openssl rand -hex 32)"
export AUTH_DATABASE_URL='postgres://messenger:YOUR_LOCAL_PASSWORD@127.0.0.1:15432/messenger?sslmode=disable'
HTTP_ADDR=127.0.0.1:8081 ./bin/auth
```

Значение `JWT_SECRET` должно быть одним и тем же у auth/chat/history.
URL-кодируйте специальные символы username/пароля в URL подключения.
Auth читает только окружение процесса, `.env` автоматически не загружает.
Миграции применяются отдельно, при запуске Auth схему не изменяет.

| Переменная | По умолчанию | Назначение |
| --- | --- | --- |
| `AUTH_DATABASE_URL` | нет | PostgreSQL URL/DSN; обязательна, содержит секрет |
| `JWT_SECRET` | нет | Общий HS256-секрет минимум 32 байта |
| `HTTP_ADDR` | `:8080` | Адрес HTTP listener |
| `SERVICE_NAME` | `auth` | Поле service JSON-логов |
| `LOG_LEVEL` | `INFO` | Уровень slog |
| `SHUTDOWN_TIMEOUT` | `10s` | Время завершения активных запросов |

TLS завершается на внешнем Nginx. Refresh cookie всегда `Secure`: браузерный
сценарий login/refresh/logout проверяйте через HTTPS, в том числе локально.
HTTP listener предназначен для внутренней сети или локальной диагностики.
Docker-образ подключается в #26, Nginx — в #36, автодеплой — в #37, staging — в #38.
В #36 внешний путь должен оставаться `/auth/...` по OpenAPI: cookie имеет
`Path=/auth` и не будет отправляться браузером на `/api/auth/...`. Если команда
выберет другой внешний префикс, сначала нужно отдельно согласовать изменение
OpenAPI и cookie Path; в этой реализации контракт сохранён.

## Поведение API

- `POST /auth/register`: 201 с `id`, исходным `username`, `created_at`,
  без автоматического входа и cookie; занятый username без учёта регистра — 409.
- `POST /auth/login`: 200 с `token_type: Bearer`, `access_token`, `expires_in: 900`;
  неизвестный username и неверный пароль дают одинаковый 401.
- `POST /auth/refresh`: refresh только из cookie; 200 с новым access и новым
  refresh cookie. Старый refresh отзывается в той же транзакции.
- `POST /auth/logout`: отзыв только предъявленной сессии, удаление cookie,
  пустой 204. Отсутствующий, истёкший и уже отозванный refresh дают 401,
  как определено текущим контрактом.

Эти четыре маршрута не требуют access JWT. `/me`, поиск, контакты и внутренний
lookup реализуются в следующих задачах. Существующие access JWT продолжают
действовать до своего `exp` после logout; logout отзывает refresh.

Register/login принимают `application/json`, ровно поля `username` и `password`.
Неизвестные, повторные и пропущенные поля, неверные типы, некорректный UTF-8,
дополнительное JSON-значение и тело больше 1 MiB дают 422. Username — 3–32 ASCII
буквы/цифры/подчёркивания, пароль — минимум 8 Unicode code points; пробелы и
исходный пароль сохраняются без trim/нормализации и без предела bcrypt 72 байта.
Ошибки возвращаются как `ApiError` с `request_id`, ответы Auth имеют `no-store`.

Access JWT подписывается HS256 и содержит `sub`, `iat`, `exp` со сроком 900 секунд.
Совместимость проверяется настоящим общим `pkg/jwtauth`.
Refresh — 32 криптографически случайных байта, base64url без padding; в БД
хранится только SHA-256 digest. Каждый новый refresh живёт 30 дней.
Cookie: `refresh_token`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/auth`,
без Domain. Refresh никогда не возвращается в JSON. Дубли cookie отклоняются.

Пароли хранятся как Argon2id PHC: v19, 64 MiB, 3 итерации, parallelism 2,
случайная salt 16 байт, ключ 32 байта. Прочитанные параметры ограничены этим
набором. На сервис допускается до 4 одновременных KDF; ожидание отменяется
по context. Login неизвестного пользователя выполняет сравнение с dummy hash.
Прикладной context имеет timeout 10 секунд; запущенный Argon2 завершается сам.

Ротация и logout блокируют строку refresh. Срок проверяется по
`clock_timestamp()` после блокировки. Из двух конкурентных применений одного
токена успешно ровно одно. Ошибка до commit откатывает отзыв и вставку successor.
При потере подтверждения commit результат неизвестен; автоматического повтора
ротации нет, клиенту может потребоваться новый вход.

## Состояние и остановка

- `/healthz` — 200, пока HTTP-процесс отвечает.
- `/readyz` — 200 после запуска и успешного Ping PostgreSQL, иначе 503.
  Ping ограничен одной секундой; при остановке readiness сбрасывается.
- `/metrics` — внутренние Go/process-метрики общего пакета, без JWT.
- При SIGTERM listener закрывается и активным запросам даётся
  `SHUTDOWN_TIMEOUT`; при превышении соединения принудительно закрываются.

Логи — JSON с service/request_id, без body, query, паролей и токенов.
Ошибки SQL/DSN не выдаются клиенту и не пишутся в прикладные логи.
Служебные endpoints не следует публиковать через внешний Nginx.

## Проверки

```bash
make test
make lint
make build SERVICE=auth
```

Для интеграционных тестов используйте тестовый PostgreSQL и роль с CREATEDB:

```bash
AUTH_TEST_DATABASE_URL='postgres://test_user:test_password@127.0.0.1:15432/postgres?sslmode=disable' \
  go test -race -count=1 ./services/auth -run TestAuthIntegration -v
```

Тест создаёт отдельную БД `messenger_auth_test_*`, применяет настоящую миграцию
Auth и удаляет эту БД после проверки. Таблицы БД из URL не изменяются.
Без переменной integration-тест пропускается; в **Go test** CI она обязательна
и задана вместе с отдельным PostgreSQL 18.

Проверяются HTTPS login/register/refresh/logout, структура JSON и cookie,
Argon2id, совместимость JWT, независимость сессий, expiry, повтор старого refresh,
конкурентные регистрации/refresh/logout, rollback при ошибке successor и expiry
после ожидания row lock. Unit-тесты покрывают валидацию, KDF, сервисные правила,
безопасные ошибки, readiness, метрики, логи, recovery и graceful shutdown.

Перед завершением задачи нужны независимое ревью и QA на staging по
[CONTRIBUTING](../../CONTRIBUTING.md). На внешнем HTTPS проверить cookie,
ротацию/выход, ошибки 401/409/422, недоступность БД и остановку/перезапуск Auth.
