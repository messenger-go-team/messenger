# Проверки Go

В репозитории один модуль github.com/messenger-go-team/messenger.
Версия Go берётся из go.mod: сейчас **1.27.3**.
Линтер закреплён на **golangci-lint v2.15.0**.

## Makefile

Для локальных проверок нужны Go из go.mod, GNU Make и C-компилятор для race detector.
В Windows удобно работать из WSL.

~~~bash
make build
make lint
make test
~~~

- make build собирает исполняемый шаблон в bin/_template.
- make build SERVICE=auth собирает services/auth в bin/auth после копирования
  шаблона. Каталог bin исключён из Git.
- make lint запускает закреплённую версию линтера через go run; инструмент
  скачивается в Go cache при первом запуске и не добавляется в зависимости проекта.
- make test выполняет CGO_ENABLED=1 go test -race -count=1 ./... ./services/_template.
- `make test-unit` запускает unit-тесты бизнес-пакетов Auth/History с race detector,
  печатает покрытие функций и требует минимум 60% statements **в каждом пакете**.
  Профиль `coverage.unit.out` исключён из Git. БД, запущенные Auth/History и сеть
  для этих тестов не нужны; модули Go должны быть доступны локально или скачаны.

Go пропускает каталоги, начинающиеся с подчёркивания, при поиске ./....
Поэтому шаблон явно указан в make test, make lint и CI. После копирования
в services/auth, services/chat или services/history его пакеты автоматически
попадают в ./.... Одной команды go test ./... для проверки шаблона недостаточно.

Можно указать уже установленный линтер:

~~~bash
make lint GOLANGCI_LINT=golangci-lint
~~~

Он должен быть совместим с Go из go.mod. Бинарник линтера, собранный более
старым Go, может отказаться проверять проект. Версия в Makefile согласуется
с версией action в .github/workflows/ci.yml.

Шаблон содержит тесты конфигурации, health/readiness, JSON-логов и request_id,
ошибки bind, завершения активного HTTP-запроса и shutdown deadline.
Recovery проверяется на JSON 500, обрыв частичного ответа, ErrAbortHandler,
Flush/Hijack через обычные интерфейсы и ResponseController и успешный Upgrade.
Internal/metrics проверяется через обычный ./...: тесты разбирают Prometheus
экспозицию, проверяют Go/process-семейства и независимость registry.
Маршрут /metrics проверяется также в тестах шаблона вместе с health/readiness.
Корневой doc.go остаётся документационным пакетом без собственных тестов.

## Unit-покрытие сервисного слоя (#32)

`SERVICE_UNIT_PACKAGES` в Makefile задаёт явную область: `auth/internal/auth`,
`history/internal/chats`, `messages`, `reading` и `later` (пути внутри сервисов).
При добавлении нового бизнес-пакета расширяйте этот список. SQL/HTTP/gRPC adapters,
сгенерированные типы и PostgreSQL integration-тесты не повышают unit-покрытие.
`cmd/checkcoverage` считает долю выполненных statements, взвешенную по их числу,
и проверяет каждый пакет отдельно. Отсутствующий пакет, пустой профиль и значение
ниже 60% до округления приводят к ошибке; высокий соседний пакет не скрывает провал.
Проверка порога и негативные случаи самого checker входят в обычный `make test`.

Репозитории и lookup подменяются через существующие интерфейсы. В Auth часы выдачи
JWT подменяются через внутренний `clock`; production использует `time.Now`.
Refresh TTL/expiry остаются решением PostgreSQL под блокировками. Криптография
остаётся настоящей: unit-тесты не подменяют Argon2, подпись JWT или генератор токенов.

Unit-тесты History проверяют границы UUID/seq, порядок вызовов, ошибки зависимостей,
передачу identity/context, отсутствие Auth lookup для истории/курсора и отсутствие
записи курсора при GET. Они не изображают SQL-реализацию в самодельной БД.
Подсчёт чужих сообщений, монотонность, конкурентность и изоляция курсоров проверяются
настоящими PostgreSQL-тестами из #31 и `TestUnreadCountAndCursorIsolation`:
редкие seq вплоть до 9007199254740991, собственные сообщения, повтор/старый read,
неучастник, обычный GET и отклонённый запрос не меняют чужое состояние.
Для них требуется `HISTORY_TEST_DATABASE_URL`, а для Auth integration —
`AUTH_TEST_DATABASE_URL`. Без переменных integration-тесты пропускаются;
успешный `test-unit` не является доказательством проверки SQL.

Сначала запустите `make test-unit`, затем `make test` с отдельной тестовой БД и
`make lint`. HTML-профиль локально: `go tool cover -html=coverage.unit.out`.
Нельзя направлять integration-тесты на БД с рабочими данными: они создают/удаляют
свои временные базы и требуют соответствующих прав тестовой роли.

## CI

Workflow .github/workflows/ci.yml запускается на каждый PR в main и push в main,
без фильтрации путей. Setup Go читает версию из go.mod, actions закреплены по SHA.

Проверки выполняются параллельно.

- **Go lint**: официальный golangci-lint action с v2.15.0 и аргументами
  ./... ./services/_template.
- **Go test**: сначала `make test-unit` с порогом 60% по каждому бизнес-пакету,
  затем make test, включая race detector и явную проверку шаблона.
  После тестов Go выполняется `make test-nginx`: настоящий Nginx проверяет все
  три конфигурации ingress, публичные маршруты HTTP/HTTPS (включая Later),
  исходные URI/query, закрытые служебные пути, ACME и редирект. Изолированные
  echo-backend не требуют БД или секретов; подробности в [nginx/README.md](../deploy/nginx/README.md).
  Отдельный PostgreSQL 18 и `AUTH_TEST_DATABASE_URL` включают Auth integration-тесты
  через HTTPS: регистрация, вход, cookie, ротация, выход и конкуренция транзакций.
  Тесты создают и удаляют собственные БД; локальный запуск описан в
  [services/auth](../services/auth/README.md#проверки).
- **Migration integration**: отдельный PostgreSQL 18 и тесты
  `go test ./cmd/migrate -run TestMigrationsIntegration -count=1 -v`.
  Тесты создают и удаляют собственные БД, проверяют применение, откат,
  повторное применение и ограничения схемы. Для локального запуска нужен
  `MIGRATE_TEST_DATABASE_URL`, подробнее в [services/README.md](../services/README.md#интеграционные-проверки-миграций).
- **Protobuf generation**: make proto, проверка формата/lint схемы и отсутствия
  изменений и новых незакоммиченных файлов в api/gen после генерации.
- **Docker build (auth, chat, history)** собирает каждый образ из корня
  репозитория. В финальном этапе каждого Dockerfile задавайте `USER 65532:65532`.
  Явный UID защищает от случайного запуска от root, а явный GID исключает
  группу root по умолчанию в `scratch`. CI проверяет точное значение `.Config.User`.
  При обновлении Go синхронизируйте версию в трёх Dockerfile с `go.mod`.

Timeout Go lint, Go test и Migration integration - 5 минут, Protobuf generation
и Docker build - 10 минут. Кеш Go учитывает go.mod и go.sum.
Новый push в ту же ветку PR отменяет устаревший прогон.
Проверка сборки выбранного исполняемого сервиса выполняется локально через make build;
Go test в CI также компилирует проверяемые пакеты.

## Frontend CI

Workflow `.github/workflows/frontend-ci.yml` запускается при каждом
pull request в `main` и при push в `main`, без фильтрации путей.

Задание **Frontend checks** выполняется на Ubuntu с Node.js 22.
Зависимости устанавливаются через `npm ci` из `web/package-lock.json`.

Проверки выполняются последовательно из каталога `web`:

- `npm run format:check` — проверка форматирования Prettier.
- `npm run lint` — проверка кода ESLint.
- `npm run typecheck` — проверка типов TypeScript.
- `npm run test` — запуск тестов Vitest.
- `npm run build` — проверка production-сборки.

Если любая команда завершается с ошибкой, задание Frontend checks
не проходит. Новый push в ту же ветку PR отменяет устаревший запуск.

**Frontend checks** — обязательная проверка для слияния в `main`
наряду с **Go lint** и **Go test**.
Требование обеспечивается настройками GitHub ruleset.

## Обязательные проверки перед merge

Правила main требуют **Go lint**, **Go test** и **Frontend checks** от GitHub Actions,
актуальную ветку и закрытые обсуждения. Настройки описаны в
[repository-rules.md](repository-rules.md).
Сам workflow запускает проверки; запрет merge задаётся ruleset.

Запуск и копирование шаблона: [services/_template/README.md](../services/_template/README.md).
Источники: [T04](https://github.com/messenger-go-team/messenger/issues/4),
[T06](https://github.com/messenger-go-team/messenger/issues/6),
[SPEC NFR-6, NFR-7](SPEC.md).
Генерация gRPC-контракта: [api/proto/README.md](../api/proto/README.md).
