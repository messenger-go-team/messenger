# Окружения и деплой

Здесь будут храниться Docker Compose-конфигурации и настройки Nginx.
Источник требований - [SPEC, раздел 9](../docs/SPEC.md).

- Local: PostgreSQL, Redis и сервисы для разработки.
- Staging: стенд QA с автоматическим деплоем из `main`.
- Production: публичное приложение; отдельный Compose-проект на том же VPS.

Первая задача -
[T05: локальный Docker Compose](https://github.com/messenger-go-team/messenger/issues/5).
Далее добавляются образы сервисов
([T26](https://github.com/messenger-go-team/messenger/issues/26)), Nginx
([T36](https://github.com/messenger-go-team/messenger/issues/36)) и автодеплой
([T37](https://github.com/messenger-go-team/messenger/issues/37)).

Команды запуска появятся вместе с конфигурацией. В репозиторий добавляются
только шаблоны настроек; секреты передаются через переменные окружения
и GitHub Secrets.
