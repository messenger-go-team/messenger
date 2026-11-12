# ER-диаграмма

Источник: [схема БД](schema.md), [T11](https://github.com/messenger-go-team/messenger/issues/11).

```mermaid
erDiagram
    AUTH_USERS {
        uuid id PK
        varchar username
        varchar username_normalized UK
        text password_hash
        timestamptz created_at
    }
    AUTH_REFRESH_TOKENS {
        uuid id PK
        uuid user_id FK
        text token_hash UK
        timestamptz expires_at
        timestamptz revoked_at
        timestamptz created_at
    }
    AUTH_CONTACTS {
        uuid user_id PK, FK
        uuid contact_id PK, FK
        timestamptz created_at
    }
    HISTORY_CHATS {
        uuid id PK
        text type
        text title
        timestamptz created_at
        bigint last_seq
    }
    HISTORY_CHAT_MEMBERS {
        uuid chat_id PK, FK
        uuid user_id PK
        text role
        timestamptz joined_at
        bigint last_delivered_seq
        bigint last_read_seq
    }
    HISTORY_PERSONAL_CHAT_PAIRS {
        uuid user_low_id PK
        uuid user_high_id PK
        uuid chat_id FK, UK
    }
    HISTORY_MESSAGES {
        uuid id PK
        uuid chat_id FK
        bigint seq
        uuid sender_id FK
        uuid client_msg_id
        text body
        timestamptz created_at
    }

    AUTH_USERS ||--o{ AUTH_REFRESH_TOKENS : owns
    AUTH_USERS ||--o{ AUTH_CONTACTS : owns
    AUTH_USERS ||--o{ AUTH_CONTACTS : added_as
    HISTORY_CHATS ||--o{ HISTORY_CHAT_MEMBERS : has
    HISTORY_CHATS ||--o| HISTORY_PERSONAL_CHAT_PAIRS : represents
    HISTORY_CHATS ||--o{ HISTORY_MESSAGES : contains
    HISTORY_CHAT_MEMBERS ||--o{ HISTORY_MESSAGES : sends
```

UUID-поля `history.chat_members.user_id`, `history.personal_chat_pairs.*` и
`history.messages.sender_id` логически ссылаются на `auth.users`, но не имеют
внешних ключей между сервисными схемами. Подробнее - в [схеме БД](schema.md).

Составные ключи, которые нельзя трактовать как уникальность отдельных полей:

- `auth.contacts`: PK `(user_id, contact_id)`.
- `history.chat_members`: PK `(chat_id, user_id)`.
- `history.personal_chat_pairs`: PK `(user_low_id, user_high_id)`,
  CHECK `user_low_id < user_high_id`; `chat_id` уникален отдельно.
- `history.messages`: UNIQUE `(chat_id, seq)` и
  `(chat_id, sender_id, client_msg_id)`; FK `(chat_id, sender_id)` ссылается
  на `history.chat_members(chat_id, user_id)`.

Кардинальности показывают ограничения связей БД. Сервис дополнительно
гарантирует: у личного чата ровно два участника и одна каноническая пара,
созданные в одной транзакции. Поле `type` допускает будущие группы, поэтому
общая связь chats/members не задаёт фиксированное число участников.
