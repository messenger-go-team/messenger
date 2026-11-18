# GitHub Actions и первый выкат staging (#37)

После успешного **Go CI** на push в `main` workflow **Deploy staging** ждёт успешный
**Frontend CI** на том же SHA. Ручной запуск доступен из `main` и также
проверяет оба CI. Если в `main` уже другой коммит, старый запуск
пропускается. В Actions группа `deploy-staging` выполняет по одному выкату.
На VPS приёмник и скрипт выката используют локальные блокировки.

Путь релиза: merge → Go CI / Frontend CI → SSH `deploy SHA` → сборка на VPS →
миграции и grants → Auth/Chat/History → health/readiness → Nginx → публичный HTTPS.
[Порядок переключения и отката](staging-release.md).

## Настройка окружения один раз

1. Создать GitHub Environment `staging` и разрешить deployments только с ветки
   `main`. Создать переменные `STAGING_SSH_HOST` и `STAGING_KNOWN_HOSTS`.
   Во второй указать строку формата known_hosts с ключом сервера, сверенным
   по доверенному администраторскому соединению.
   Держать `STAGING_DEPLOY_ENABLED=false` до проверки SSH-доступа.
2. Сгенерировать отдельный Ed25519-ключ выката. Закрытый ключ сохранить в
   Environment Secret `STAGING_SSH_KEY`. Для открытого ключа использовать
   отдельную строку в `/root/.ssh/authorized_keys`:

   ```text
   restrict,command="/usr/local/sbin/messenger-staging-receive" ssh-ed25519 <public-key> messenger-staging-actions
   ```

   VPS запускает только приёмник. Ключ поддерживает `probe` и `deploy <SHA>`.
   Приёмник сравнивает SHA с актуальным `main` до скачивания и после сборки,
   скачивает исходники по HTTPS из фиксированного репозитория и запускает
   код релиза. Поддержка произвольной оболочки, передача файлов и форвардинг
   для этого ключа отключены.
3. Установить проверенный `deploy/staging-ssh-receiver.sh` на VPS как
   `/usr/local/sbin/messenger-staging-receive`, владелец root, режим `0755`.
   Эту установочную копию обновляет администратор при изменениях протокола
   приёмника. Скрипт `staging-release.sh` обновляется с каждым релизом.
4. С отдельным ключом выполнить SSH `probe` со строгой проверкой host key.
   Ожидаемый ответ `staging receiver ready`. После этой проверки установить
   `STAGING_DEPLOY_ENABLED=true`. Первый выкат можно запустить вручную
   после merge, когда оба CI зелёные.

Роль SSH-ключа ограничена доставкой релиза. Он позволяет запустить код
проверенного `main` на VPS. Ревью изменений в `main` и настройки GitHub
Environment защищают этот путь. Значения runtime-секретов PostgreSQL, JWT
и Auth берутся из настроек Compose на существующем VPS. Они не передаются
по команде выката и не хранятся в каталоге исходников.

## Разделение окружений

| Настройка | Staging | Production |
| --- | --- | --- |
| Compose project | `messenger36-stage` | отдельный проект `messenger-prod` |
| Рабочий каталог | `/root/messenger36-stage` | отдельный каталог `/root/messenger-prod` |
| Сеть и БД | собственная сеть и `messenger_stage` | собственная сеть, volume и БД |
| Environment | `staging` | отдельный `production` при запуске production |

Для production при подготовке окружения создаются отдельные runtime-настройки,
секреты, тома и конфигурация ingress. Вариант с одинаковым Compose project,
именованными volumes или открытыми портами PostgreSQL для обоих окружений
привёл бы к пересечению состояния. Workflow этой задачи вызывает staging,
а путь и проект в приёмнике закреплены.

## После первого запуска

Зафиксировать URL запуска Actions и полный SHA. Сверить логи миграций,
успешные пробы трёх сервисов, `nginx -t` и публичные ответы. Если переключение
завершится ошибкой, скрипт вернёт прежние образы и snippet, а workflow
останется красным. Для ручного отката оператор запускает на VPS
`staging-release.sh rollback` из каталога релиза. Данные v2 сохраняются.
