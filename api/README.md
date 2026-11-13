# Контракты API

Контракты описываются и согласовываются до реализации.
Источник требований - [SPEC, разделы 6 и 8](../docs/SPEC.md).

Расположение контрактов:

| Путь | Содержание | Задача |
| --- | --- | --- |
| [openapi/auth.yaml](openapi/auth.yaml) | REST: регистрация, вход, токены, профиль, поиск и контакты | [T07](https://github.com/messenger-go-team/messenger/issues/7) |
| [openapi/history.yaml](openapi/history.yaml) | REST: личные чаты, список чатов и история | [T08](https://github.com/messenger-go-team/messenger/issues/8) |
| [ws/events.md](ws/events.md) | События WebSocket, примеры и ошибки | [T09](https://github.com/messenger-go-team/messenger/issues/9) |
| [proto/history.proto](proto/history.proto) | gRPC: chat → history | [T10](https://github.com/messenger-go-team/messenger/issues/10) |

Изменения контрактов проходят через PR с согласованием фронтенда и владельца сервиса.

Правила gRPC, ошибки и генерация Go-кода: [proto/README.md](proto/README.md).
