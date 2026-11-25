# Веб-клиент Messenger

Веб-клиент мессенджера на React и TypeScript.

Стек проекта определён в [SPEC](../docs/SPEC.md). Язык интерфейса — русский.

## Технологический стек

- **React** — разработка пользовательского интерфейса.
- **TypeScript** — статическая типизация.
- **Vite** — локальный сервер разработки и сборка приложения.
- **Tailwind CSS v4** — стилизация интерфейса.
- **shadcn/ui** — компоненты пользовательского интерфейса.
- **Base UI** — основа интерактивных компонентов shadcn/ui.
- **Lucide React** — иконки.
- **Geist** — шрифт интерфейса.

## Требования

- Node.js: `^20.19.0 || >=22.12.0` (требование Vite 8).
- npm.

Для воспроизводимой установки зависимостей используется `package-lock.json`.

## Локальный запуск

Перейдите в директорию веб-клиента:

```bash
cd web
```

Установите зависимости:

```bash
npm ci
```

При первом запуске скопируйте шаблон переменных окружения:

```bash
cp .env.example .env.local
```

По умолчанию включены MSW-моки (`VITE_API_MOCK=true`). Подробности и
переключение на реальный backend — в разделе [REST API и MSW](#rest-api-и-msw).

Запустите сервер разработки:

```bash
npm run dev
```

Vite выведет адрес приложения в терминале. Обычно это:

http://localhost:5173/

## Доступные команды

| Команда                | Назначение                              |
| ---------------------- | --------------------------------------- |
| `npm run dev`          | Запуск сервера разработки               |
| `npm run typecheck`    | Проверка типов TypeScript               |
| `npm run lint`         | Проверка кода с помощью ESLint          |
| `npm run test`         | Запуск автоматизированных тестов        |
| `npm run build`        | Проверка TypeScript и production-сборка |
| `npm run format:check` | Проверка форматирования                 |
| `npm run preview`      | Локальный просмотр production-сборки    |

Перед созданием Pull Request рекомендуется выполнить:

```bash
npm run lint
npm run build
```

`npm run preview` предназначена для локальной проверки сборки, а не для размещения приложения в production.

`npm run test` — однократный запуск автоматизированных тестов с помощью Vitest.
Тесты проверяют рендер приложения, API-клиент, MSW-обработчики, моковые данные,
JWT и корректность объединения Tailwind-классов функцией `cn()`.

## Структура проекта

```text
web/
├── public/                 # Публичные статические файлы
├── src/
│   ├── components/
│   │   └── ui/             # Компоненты shadcn/ui
│   ├── lib/
│   │   └── utils.ts        # Общие утилиты
│   ├── App.tsx             # Корневой компонент приложения
│   ├── index.css           # Tailwind CSS и переменные темы
│   └── main.tsx            # Точка входа React
├── components.json         # Конфигурация shadcn/ui
├── eslint.config.js        # Конфигурация ESLint
├── package.json            # Зависимости и npm-скрипты
├── package-lock.json       # Зафиксированное дерево зависимостей
├── tsconfig.json           # Конфигурация TypeScript
└── vite.config.ts          # Конфигурация Vite
```

Для импортов из `src/` настроен alias `@/`.

Пример:

```tsx
import { Button } from '@/components/ui/button'
```

## Стили и компоненты

Проект использует Tailwind CSS v4 и shadcn/ui с конфигурацией Base UI и стилем Nova.

Основные параметры темы, включая цвета и радиусы скругления, определены через CSS-переменные в `src/index.css`.

Компоненты shadcn/ui размещаются в `src/components/ui/` и могут адаптироваться под требования дизайна проекта.

## Экраны MVP

В рамках MVP запланированы:

- Вход.
- Регистрация.
- Список чатов.
- Окно чата.
- Профиль пользователя.

Для экранов предусматриваются мобильная, планшетная и десктопная раскладки.

На текущем этапе реализован базовый каркас приложения. Полноценные экраны и интеграции будут разрабатываться в отдельных задачах.

## Задачи и интеграции

Инициализация фронтенда выполняется в [T17](https://github.com/messenger-go-team/messenger/issues/17).

До готовности бэкенда запланирована работа с моками:

- [T19 — REST-моки по OpenAPI](https://github.com/messenger-go-team/messenger/issues/19).
- [T20 — Мок WebSocket-сервера](https://github.com/messenger-go-team/messenger/issues/20).

## Документация

- [SPEC проекта](../docs/SPEC.md)
- [Правила репозитория](../docs/repository-rules.md)
- [CI](../docs/ci.md)
- [Команда](../docs/team.md)

Подробные технические решения описаны в [документации фронтенда](../docs/frontend.md).

## REST API и MSW

Для запуска без backend:

```bash
VITE_API_MOCK=true npm run dev
```

`VITE_API_MOCK` включает MSW только при точном значении `true`. Worker запускается
до рендера React. Для моков оставьте `VITE_API_BASE_URL` пустым: обработчики
используют пути текущего origin. Поддерживаются POST `/auth/register`,
`/auth/login`, `/auth/refresh`, `/auth/logout`, GET `/me`, `/users/search`,
`/contacts`, PUT и DELETE `/contacts/{contact_id}`, POST `/chats/personal`,
GET `/chats`, GET `/chats/{chat_id}/messages` и POST `/chats/{chat_id}/read`.

Для реального backend:

```bash
VITE_API_MOCK=false VITE_API_BASE_URL=http://localhost:8080 npm run dev
```

В этом режиме модуль MSW не загружается и worker не запускается. Base URL —
адрес API (может включать префикс пути); завершающий слеш необязателен.
Пустое значение означает текущий origin. Backend должен разрешать CORS с
credentials, если origin отличается. Все запросы отправляют `credentials: include`.
Шаблон переменных — `.env.example`. Скопируйте его в `.env.local` и при
необходимости измените значения; после изменения перезапустите Vite.
Не помещайте секреты в `VITE_*`: они доступны в клиентской сборке.

### Staging (`/app/`)

На staging SPA отдаётся под `https://staging.tidingm.ru/app/`. Экраны —
`/app/login`, `/app/contacts`, `/app/later`; REST и WSS остаются на корне
домена (`/contacts`, `/later`, `/ws`).

```bash
npm run build:staging
npm run preview -- --mode staging
```

`build:staging` использует режим Vite `staging`. В `.env.staging`
заданы `VITE_APP_BASE=/app/`, `VITE_API_MOCK=false` и пустые
`VITE_API_BASE_URL` и `VITE_WS_ORIGIN`. Vite проверяет итоговые значения
после чтения файлов окружения и переменных процесса. Если переопределение
меняет префикс, включает моки или задаёт отдельный адрес API или WS,
сборка останавливается. `.env.staging` перекрывает `.env.local`.

Для выкладки скачайте артефакт `web-dist-<SHA>-attempt-<номер>` из успешного
запуска **Frontend CI**. SHA в имени соответствует коммиту, который собрал
workflow: в запуске pull request это merge-коммит GitHub, в запуске из
`main` это коммит `main`. Извлеките `index.html` и `assets/` и публикуйте
их под `/app/`. Проверьте SHA сборки и SHA бэкенда в отчёте о выкате.
Автоматический выкат и откат описаны в [#166](https://github.com/messenger-go-team/messenger/issues/166).

Обычный `npm run build` использует `.env.production` и допускает другой
префикс или отдельные адреса API и WS. Для своего префикса, например
`VITE_APP_BASE=/trial/`, задайте одинаковое значение у `build` и
`preview`. Обе сборки отклоняют `VITE_API_MOCK=true`. Для локального MSW
используйте `npm run dev` и корневой base: worker перехватывает API на корне.

Публичные пользователи исключительно для локального MSW: `alice_1` и `bob_2`,
пароль обоих — `correct-horse-battery`. Между ними подготовлен личный чат с
детерминированной историей сообщений. Можно регистрировать других пользователей.
Пользователи, контакты, чаты, сообщения, курсоры прочтения и refresh-сессии
хранятся в памяти и сбрасываются при перезагрузке; в тестах состояние сбрасывается
после каждого сценария. JWT подписывается публичным тестовым ключом и непригоден
для серверной авторизации.

MSW не является настоящим сервером: browser worker сохраняет синтетическую
HttpOnly refresh cookie во внутреннем cookie store и передаёт её handlers через
resolver `cookies`. В браузерном mock-режиме MSW сохраняет данные этого store в
`localStorage`; это деталь эмуляции, а не эквивалент защиты настоящей HttpOnly-cookie
backend-сервера. Поэтому mock refresh-token может быть доступен клиентской среде и
не должен считаться защищённым как в production. В Node/jsdom browser cookie store
отсутствует, поэтому тесты сессий явно передают Cookie header. WebSocket не входит
в эти моки.

History поддерживает курсорную пагинацию `before_seq` или `after_seq`, лимит от 1
до 100 и выдаёт сообщения по `seq` по возрастанию. Получение истории не отмечает
сообщения прочитанными: для этого используется отдельный `/read`. REST endpoint
отправки сообщения отсутствует в контракте и не замокан; подготовленные сообщения
имитируют данные, сохранённые chat-сервисом. Внутренний `/internal/users` не
предназначен для браузера и не замокан.

Проверки из `web/`:

```bash
npm run typecheck
npm run lint
npm run test
npm run build
npm run format:check
```

Vitest использует MSW server; тесты проверяют auth, пользователей, контакты,
History API, JWT и HTTP-клиент.
