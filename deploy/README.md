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

## Следующие шаги

Образы Go-сервисов добавляются в
[T26](https://github.com/messenger-go-team/messenger/issues/26), Nginx -
в [T36](https://github.com/messenger-go-team/messenger/issues/36), автодеплой -
в [T37](https://github.com/messenger-go-team/messenger/issues/37).
Секреты staging и production передаются через переменные окружения
и GitHub Secrets.

Справка: [Compose include](https://docs.docker.com/compose/how-tos/multiple-compose-files/include/),
[образ PostgreSQL](https://hub.docker.com/_/postgres),
[Redis CLI](https://redis.io/docs/latest/develop/tools/cli/).
