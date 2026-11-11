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

## CI

Workflow .github/workflows/ci.yml запускается на каждый PR в main и push в main,
без фильтрации путей. Setup Go читает версию из go.mod, actions закреплены по SHA.

Два задания выполняются параллельно:

- **Go lint**: официальный golangci-lint action с v2.15.0 и аргументами
  ./... ./services/_template.
- **Go test**: make test, включая race detector и явную проверку шаблона.

Timeout каждого задания - 5 минут. Кеш учитывает go.mod и go.sum.
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