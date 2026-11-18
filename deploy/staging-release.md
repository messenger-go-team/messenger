# Переключение и откат staging (#37)

[Скрипт staging-release.sh](staging-release.sh) запускается от пользователя
staging с доступом к отдельному rootless Docker. Базовый Compose,
сеть и внутренний Nginx должны быть готовы. Подготовка сервера описана
в [staging-actions.md](staging-actions.md).

## Что принимает скрипт

```bash
bash "$RELEASE_DIR/deploy/staging-release.sh" deploy "$SHA" "$RELEASE_DIR"
```

`SHA` - полный SHA разрешённого коммита. В каталоге релиза лежат
`REVISION`, статические `migrate` и `staging-wss-probe`, SQL из
`services/{auth,history}/migrations` и публичный snippet Nginx.
В rootless Docker уже должны быть образы
`messenger36-stage-{auth,chat,history}:$SHA` с OCI-меткой
`org.opencontainers.image.revision=$SHA`. В режиме CD их готовит SSH-приёмник.

По умолчанию Compose находится в `~/messenger36-stage/compose.yaml`,
проект называется `messenger36-stage`, внутренний Nginx -
`messenger36-ingress`. Его snippets лежат в
`~/messenger36-stage/nginx/snippets`. Для локальной лаборатории параметры
задаются через `STAGING_ROOT`, `STAGING_PROJECT`, `STAGING_INGRESS`,
`STAGING_SNIPPETS` и `STAGING_URL`.

`~/messenger36-stage/wss-probe.json` - приватный файл (0600) с
`username` и `password` отдельного тестового аккаунта Auth.
Переопределения для диагностики - `STAGING_WSS_CREDENTIALS` и
`STAGING_WSS_PROBE`. Проба входит через HTTPS и ждёт `101` с
`messenger.v1` на публичном `/ws`. Секреты, JWT и тело ответа она
не пишет в отчёт.

## Порядок выката

1. Сверяем образы, сеть и mounts. Сохраняем прежние image ID и
   публичный snippet. Проверяем версии схемы. Поддерживаются
   Auth v1 и History v1/v2 с `dirty=false`. Перед переходом History
   v1 на v2 сохраняем дамп. Для будущих миграций сначала проверяем
   совместимость предыдущей версии приложения с новой схемой.
2. Применяем миграции отдельным контейнером, выдаём минимальные права
   Later рабочей роли. Compose переключает Auth, Chat и History.
   PostgreSQL продолжает работать в том же проекте.
3. Проверяем ID образов, `/healthz` и `/readyz`. Копируем публичный
   snippet, выполняем `nginx -t` и reload внутреннего Nginx. Сверяем
   маркер загруженной конфигурации через локальный порт внутри
   контейнера, затем выполняем HTTPS smoke и WSS handshake.
4. Подтверждённый SHA сохраняется после проверок. Повтор активного SHA
   проверяет состояние без пересоздания контейнеров и без потери
   предыдущей точки отката. При обоих исходах скрипт возвращает SHA и
   идентификатор переключения для восстановления записи GitHub Deployments.

После первого переключения Compose использует `compose.release.yaml`
как override. Для ручного управления указывайте его после базового Compose.
Снимки в `.release-state/` и соответствующие теги Docker нужны для отката.

## Откат

Перед ручным откатом отключите CD, отмените ожидающие запуски и дождитесь
завершения текущего job `Release to staging`, включая публикацию статуса.
После отката запишите фактический SHA и результат smoke в журнале
оператора. История GitHub Deployments показывает выкаты через Actions,
а фактическое состояние проверяется на VPS.

```bash
bash "$RELEASE_DIR/deploy/staging-release.sh" rollback
```

Запускайте из готового каталога релиза с WSS-пробой. Соблюдайте тот же
Docker-контекст пользователя staging. Если выкат C после A → B сорвался,
скрипт восстанавливает B, а ручной откат остаётся доступен на A. Восстановление
также проходит HTTP и WSS-проверки. Схема v2 и данные PostgreSQL сохраняются.

Если переключение прервалось до подтверждения нового релиза, `rollback`
сначала восстанавливает состояние перед попыткой. При ошибке восстановления
снимок и пометка незавершённой попытки остаются на диске для диагностики.

Локальная регрессия использует реальные приложения, PostgreSQL и два Nginx.
Она покрывает A → В, повторный выкат В, некорректный Nginx, ответ 404 вместо
WebSocket Upgrade и ручной откат на А с сохранением данных:

```bash
python3 deploy/test-staging-release.py
```
