# Окружения и деплой

Источник требований - [SPEC, раздел 9](../docs/SPEC.md).

- Local: PostgreSQL, Redis и будущие сервисы для разработки.
- Staging: стенд QA с автоматическим деплоем из `main`.
- Production: публичное приложение; отдельный Compose-проект на том же VPS.

## Локальный запуск

Нужны запущенный Docker Engine или Docker Desktop и Docker Compose 2.20.3+
с поддержкой `include`. Все команды ниже выполняются **из корня репозитория**.
На Windows удобно использовать WSL.

При первом запуске:

```bash
cp .env.example .env
```

Задайте в `.env` собственные локальные пароли PostgreSQL и Redis.
Этот файл уже исключён из Git. Шаблон содержит только примеры.

Запуск в терминале:

```bash
docker compose up
```

Запуск в фоне с ожиданием готовности:

```bash
docker compose up -d --wait
docker compose ps
```

Корневой `compose.yaml` подключает `deploy/docker-compose.yml`.
Переменные читаются из корневого `.env`. В T05 запускаются только
PostgreSQL и Redis; сервисы и веб-клиент добавляются в следующих задачах.

## Подключение

| Откуда | PostgreSQL | Redis |
| --- | --- | --- |
| С компьютера разработчика | `127.0.0.1:15432` | `127.0.0.1:16379` |
| Из будущих контейнеров того же Compose-проекта | `postgres:5432` | `redis:6379` |

Имя БД и пользователь PostgreSQL по умолчанию - `messenger`.
Пароли берутся из `.env`. Порты компьютера меняются через `POSTGRES_PORT`
и `REDIS_PORT`; порты внутри контейнеров остаются прежними.
Публикация портов ограничена `127.0.0.1`.

Открыть SQL-консоль внутри контейнера:

```bash
docker compose exec postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
```

Проверить Redis:

```bash
docker compose exec redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli ping'
```

Ожидаемый ответ - `PONG`. Чтобы поработать с Redis интерактивно:

```bash
docker compose exec redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli'
```

Например, команды `SET demo hello EX 60`, `GET demo` и `TTL demo`
покажут запись значения и время жизни ключа. Без аутентификации Redis
отклоняет команды.

## Данные и остановка

PostgreSQL хранит данные в именованном volume `postgres_data`.
По умолчанию его имя в Docker - `messenger-local_postgres_data`.
Для образа PostgreSQL 18 volume смонтирован в `/var/lib/postgresql`.

Остановка и удаление контейнеров с сохранением данных PostgreSQL:

```bash
docker compose down
```

Повторный `docker compose up` использует тот же volume.
Пользователь, пароль и БД из `POSTGRES_*` создаются только при первой
инициализации пустого volume. Изменение этих переменных не обновляет
уже существующих пользователей и их пароли.

Redis работает без AOF и RDB, его каталог `/data` размещён в tmpfs.
После перезапуска процесса Redis ключи исчезают. В архитектуре проекта
это временное состояние: сообщения сохраняются в PostgreSQL.

Полный сброс локального окружения **удаляет данные PostgreSQL**:

```bash
docker compose down --volumes
```

Менять major-версию PostgreSQL для существующего volume нужно через
отдельную процедуру миграции.

## Диагностика

```bash
docker compose config --quiet
docker compose ps
docker compose logs --tail=100 postgres redis
```

Для проверки конфигурации без создания локального `.env`:

```bash
docker compose --env-file .env.example config --quiet
```

## Образы Go-сервисов

Соберите образы из корня репозитория, чтобы сборке были доступны `go.mod`,
общие Go-пакеты и сгенерированный gRPC-код.

```bash
for service in auth chat history; do
  docker build -f "services/$service/Dockerfile" -t "messenger-$service:local" .
done
```

В каждом образе находятся бинарник сервиса и корневые TLS-сертификаты.
Сервисы запускаются с UID и GID `65532`, читают настройки из окружения и
пишут логи в stdout/stderr. Переменные запуска описаны в README
[Auth](../services/auth/README.md), [Chat](../services/chat/README.md) и
[History](../services/history/README.md). Перед запуском Auth и History
подготовьте БД и [примените миграции](../services/README.md).

В CI образы собираются отдельно для каждого сервиса. Подключение Nginx
предусмотрено в [#36](https://github.com/messenger-go-team/messenger/issues/36),
автодеплой - в [#37](https://github.com/messenger-go-team/messenger/issues/37).

Порядок ручного запуска скрипта выката и отката для #37 описан в
[staging-release.md](staging-release.md).
Настройка GitHub Actions и окружения описана в [staging-actions.md](staging-actions.md).

Справка: [Compose include](https://docs.docker.com/compose/how-tos/multiple-compose-files/include/),
[образ PostgreSQL](https://hub.docker.com/_/postgres),
[Redis CLI](https://redis.io/docs/latest/develop/tools/cli/).

### Проверки состояния Go-сервисов

Compose выполняет `healthcheck.test` внутри проверяемого контейнера.
Наши `scratch`-образы содержат бинарник сервиса и корневые TLS-сертификаты.
[Документация Compose](https://docs.docker.com/reference/compose-file/services/#healthcheck).

HTTP-пробы для этих образов настраиваются на уровне развёртывания. В
[#37](https://github.com/messenger-go-team/messenger/issues/37) шаг деплоя
после запуска проверяет `/healthz` каждого сервиса по внутренней сети с VPS
или из отдельного контейнера с `curl` или `wget`. `/readyz` показывает
готовность сервиса обслуживать запросы.

## Маршрутизация Auth для T36

[snippets/auth-locations.conf](nginx/snippets/auth-locations.conf) включает
публичные пути Auth, /me, /users/search и контакты и закрывает /internal
на внешнем Nginx. Snippet размещается внутри server; upstream auth_backend
должен указывать на Auth во внутренней сети (по OpenAPI auth:8080).
Это заготовка маршрутизации #28 для интеграции в #36, а не готовый деплой.
Служебный AUTH_INTERNAL_TOKEN передаётся только Auth/History. Backend-порт
не публикуется наружу. Подробности и ограничение внутреннего HTTP:
[Auth README](../services/auth/README.md).

В `location /contacts/` используется `proxy_pass http://auth_backend` без
URI. Это сохраняет исходный путь для проверки UUID в Auth: запрос
`/contacts/x%2F..%2F<uuid>` должен вернуть `422`, не добавляя и не удаляя
контакт. С URI в proxy_pass Nginx передал бы нормализованный путь с валидным
UUID. При подключении snippet в #36 не добавляйте rewrite, меняющий этот путь.
Регрессионная проверка: [nginx/README.md](nginx/README.md).
Правила передачи URI: [документация Nginx](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass).

## Служебный секрет Auth/History для #37

Контракт: [внутренний lookup Auth](../api/openapi/auth.yaml).
До выката версии с #28 нужен `AUTH_INTERNAL_TOKEN`, иначе весь Auth
завершает запуск, включая login и refresh. В #37 реализуется следующий порядок:

1. Для каждого GitHub Environment (`staging`, `production`) создать свой
   секрет `AUTH_INTERNAL_TOKEN`. Сгенерировать криптографически случайное
   значение, например `openssl rand -hex 32`; не использовать `JWT_SECRET`.
2. Workflow получает значение из Environment Secrets и передаёт его
   в защищённое окружение развёртывания. Из него одинаковое значение
   передаётся только контейнерам Auth и History. Секрет не встраивается
   в образ, не передаётся фронтенду или Chat и не попадает в логи/артефакты.
3. До замены работающих контейнеров проверить наличие и формат обоих
   секретов: `AUTH_INTERNAL_TOKEN` содержит минимум 32 печатных ASCII-байта
   без пробелов (0x21..0x7E) и отличается от `JWT_SECRET`.
4. Развернуть сервисы с подготовленным окружением. После проверки
   готовности выполнить внутренний lookup из сети потребителя; через
   внешний HTTPS тот же запрос, даже с верным секретом, должен дать `404`.

Фрагмент для конфигурации сервисов в #26/#37:

```yaml
services:
  auth:
    environment:
      AUTH_INTERNAL_TOKEN: ${AUTH_INTERNAL_TOKEN:?AUTH_INTERNAL_TOKEN is required}
  history:
    environment:
      AUTH_INTERNAL_TOKEN: ${AUTH_INTERNAL_TOKEN:?AUTH_INTERNAL_TOKEN is required}
```

Проверка `${...:?}` отклоняет пустое значение; длина, допустимые символы
и отличие от JWT_SECRET также проверяются перед запуском Auth.
GitHub Environment Secrets передаются между шагами деплоя без вывода значений.
У staging и production разные секреты и Compose-проекты.

При обычном обновлении версии секрет сохраняется. Замена секрета проводится
согласованно у Auth и History; текущая реализация принимает один ключ.
Порядок ротации/отката фиксируется в #37 до применения новой пары настроек.
Внутренний HTTP не шифруется; внутренний TLS/mTLS согласуется отдельно.

## Проверка Auth на staging для #38

После выката записать SHA сборки и результаты:

- Login и refresh работают с подготовленным окружением; `/readyz` Auth
  возвращает `200` при доступной схеме БД.
- Из внутренней сети History lookup с общим служебным секретом возвращает
  только `id` и `username`; пользовательский JWT и неверный секрет дают `401`.
- Через внешний HTTPS `/internal`, `/internal/...` и кодированные обходные
  пути дают `404`, в том числе с верным служебным секретом. Backend-порт
  Auth недоступен из внешней сети.
- Валидные PUT/DELETE контакта дают `204`. Путь с некорректным ID
  `/contacts/x%2F..%2F<uuid>` даёт `422` для обоих методов, а собственный
  список контактов после каждого запроса остаётся прежним.

Воспроизводимый тест маршрутизации описан в [nginx/README.md](nginx/README.md).
Создание стенда, подключение секретов и результат реального staging QA
остаются в #37/#38.

## Подключение Later API History (#87)

Перед выкладкой версии с #87 применить History migration v2 отдельным мигратором.
Базовые права History из #29/#31 сохраняются. Дополнительно рабочей роли нужны
SELECT/INSERT на history.later_entries, UPDATE(due_at,state,updated_at) на этой
таблице и UPDATE хотя бы одной колонки source-таблиц для FOR KEY SHARE. Для messages
достаточно UPDATE(id); существующие UPDATE last_seq/read/delivered покрывают
chats/chat_members. DELETE Later и полный UPDATE таблиц не требуются.
Права выдаются runtime-роли, а не только владельцу миграций.

/readyz объединяет базовую схему History и Later.Ready: без v2 или grants будет
503. Readiness проверяет схему/права; version=2/dirty=false в журнале нужно
отдельно подтвердить мигратором перед выкатом. Миграция не запускается
автоматически при старте. Одноступенчатый down v2
уничтожает личные записи и делает новую сборку неготовой; это не штатный способ
отката приложения с сохранением данных. Старые сообщения down v2 не удаляет.

В #36 маршрутизировать точный /later и префикс /later/ в History, сохраняя исходный
URI в proxy_pass без URI-части, как для публичных Auth-маршрутов. Не открывать
внешний доступ к внутренним портам или /internal. На staging #38/#49/#50 записать
SHA, версию 2/dirty=false, результат readiness, два аккаунта, приватность,
сохранение/перенос/done/reload и недоступность источника. Эти пункты являются
инструкцией проверки, а не отчётом о выполненной staging QA.

## Подключение публичных статусов History (#130)

Перед переключением сервисов применить History migration v3 и подтвердить
`version=3, dirty=false`. Runtime-роли History нужны права
`UPDATE(public_last_delivered_seq, public_last_read_seq)` на
`history.chat_members` в дополнение к правам MVP. `/readyz` проверяет схему
и оба гранта. Миграция сохраняет приватные курсоры и начинает публичные с нуля.

Публичный HTTPS-маршрут `GET /chats/{chat_id}/receipts` проходит через Nginx
в History с исходным URI. Проверить 401 без токена и 200 с `Cache-Control: no-store`
для участника личного чата. Внутренний gRPC остаётся в сети сервисов.
Автоматический откат сервиса сохраняет схему v3 и публичные значения.
Одноступенчатый down v3 удаляет публичные курсоры.
