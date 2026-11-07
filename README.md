# Messenger

Командный проект для портфолио: веб-мессенджер на Go с личными чатами,
историей сообщений и доставкой в реальном времени по WebSocket.

Дата показа руководителю практики: **7 декабря 2026 года**.

Требования, границы этапов и принятые решения описаны в [SPEC](docs/SPEC.md).
Групповые чаты запланированы после показа.

## Первый результат: MVP

- Регистрация и вход по username и паролю.
- Поиск пользователей и создание личного чата.
- Обмен текстовыми сообщениями в реальном времени.
- Сохранение истории и курсорная пагинация.
- Подтверждение сохранения сообщения, защита от дублей и переподключение.
- Адаптивный веб-клиент для мобильной, планшетной и десктопной ширины.

Критерий готовности MVP: два пользователя регистрируются, входят и
переписываются на staging; история сохраняется и доступна после перезагрузки.

## Архитектура

Браузер обращается к сервисам через Nginx по HTTPS и WSS.

| Компонент | Ответственность |
| --- | --- |
| auth | Пользователи, access/refresh-токены и контакты |
| chat | WebSocket-соединения и доставка событий участникам чата |
| history | Чаты, участники, сохранение сообщений, назначение seq и история |
| PostgreSQL | Постоянное хранение данных, источник истины |
| Redis | Обмен событиями между инстансами chat и presence на последующих этапах |
| Nginx | TLS, раздача фронтенда, маршрутизация и балансировка |

Внешние контракты: REST/JSON и WebSocket. Вызовы chat → history: gRPC.
Веб-клиент: React, TypeScript, Tailwind CSS и shadcn/ui.
Деплой: Docker Compose на VPS.

## Структура репозитория

```text
api/          REST, WebSocket и gRPC-контракты
deploy/       Окружения Docker Compose и конфигурация Nginx
docs/         SPEC и документация проекта
services/     Go-сервисы auth, chat и history
web/          Веб-клиент
LICENSE       Лицензия MIT
```

Назначение каталогов подробнее описано в [api](api/README.md),
[deploy](deploy/README.md), [services](services/README.md) и [web](web/README.md).

## Подготовка к разработке и запуск

Склонируйте репозиторий:

```bash
git clone https://github.com/messenger-go-team/messenger.git
cd messenger
```

Для локального окружения нужны запущенный Docker Engine или Docker Desktop
и Docker Compose 2.20.3+.

При первом запуске создайте локальные настройки:

```bash
cp .env.example .env
```

Задайте в `.env` собственные локальные пароли PostgreSQL и Redis.
Затем запускайте окружение из корня репозитория:

```bash
docker compose up
```

Для запуска в фоне и проверки готовности:

```bash
docker compose up -d --wait
docker compose ps
```

По умолчанию PostgreSQL доступен на `127.0.0.1:15432`, Redis -
на `127.0.0.1:16379`. Данные PostgreSQL хранятся в именованном volume.
Команды подключения, остановки и сброса описаны в [deploy/README.md](deploy/README.md).

Сейчас запускаются PostgreSQL и Redis. Каркас Go-сервисов добавляется в
[T06](https://github.com/messenger-go-team/messenger/issues/6), веб-клиент -
в [T17](https://github.com/messenger-go-team/messenger/issues/17).

Файлы `.env` и `.env.*` с локальными настройками не коммитим.
Шаблон `.env.example` содержит только примеры.

## Проверки Go

Go-проект использует один корневой модуль и версию из `go.mod`.
На каждом PR в `main` запускаются **Go lint** и **Go test** с race detector.
Команды локальной проверки и настройки CI описаны в [docs/ci.md](docs/ci.md).

## Работа с задачами

Задачи и критерии приёмки находятся в
[GitHub Issues](https://github.com/messenger-go-team/messenger/issues).
Изменения готовим в отдельной ветке и отправляем pull request в `main`.
В PR указываем связанную задачу, например `Closes #2`.
Правила веток, ревью, squash merge и Definition of Done описаны в
[CONTRIBUTING.md](CONTRIBUTING.md).
Состав команды и распределение ревью - в [docs/team.md](docs/team.md).

## Лицензия

[MIT](LICENSE).
