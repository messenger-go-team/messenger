# Схема PostgreSQL

Источник: [SPEC §6-7](../SPEC.md), [T11](https://github.com/messenger-go-team/messenger/issues/11),
[auth OpenAPI](../../api/openapi/auth.yaml), [history OpenAPI](../../api/openapi/history.yaml).

## Границы владения

База данных одна, но таблицы разделены PostgreSQL-схемами по владельцу.

| PostgreSQL-схема | Владелец | Таблицы |
| --- | --- | --- |
| `auth` | auth-сервис | `users`, `refresh_tokens`, `contacts` |
| `history` | history-сервис | `chats`, `chat_members`, `personal_chat_pairs`, `messages` |

`history` хранит UUID пользователей без внешнего ключа на `auth.users`. Иначе
миграции history напрямую зависели бы от схемы, которой владеет другой сервис.
Перед созданием личного чата history проверяет пользователя через внутренний
метод auth, а права на чат - только по `history.chat_members`.

UUID первичных ключей и серверные `timestamptz` создаются на сервере.
Время передаётся в API в формате RFC 3339; пароли и исходные refresh-токены
никогда не попадают в ответы профиля или истории.

## Таблицы auth

### `auth.users`

| Поле | Тип | Ограничение | Назначение |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | Идентификатор пользователя |
| `username` | `varchar(32)` | NOT NULL, pattern `^[A-Za-z0-9_]{3,32}$` | Отображаемое написание username |
| `username_normalized` | `varchar(32)` | NOT NULL, UNIQUE | ASCII lower-case версия `username` |
| `password_hash` | `text` | NOT NULL | bcrypt или argon2-хеш пароля |
| `created_at` | `timestamptz` | NOT NULL | Время регистрации |

`username_normalized` вычисляется из `username` и не принимается от клиента.
Уникальный индекс на нём реализует принятое правило: `Alex` и `alex` - один
username, а исходное написание остаётся доступно в `username`.
В T12 нужно закрепить соответствие полей через
`CHECK (username_normalized = translate(username, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'))`.
Для нормализованного поля используется collation `"C"`: сравнение и порядок
ASCII-имён не должны зависеть от locale базы данных. Prefix-поиск использует
то же преобразование регистра; символ `_` в поисковом вводе является
буквальным символом, поэтому при использовании `LIKE` его нужно экранировать.

### `auth.refresh_tokens`

| Поле | Тип | Ограничение | Назначение |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | Идентификатор записи токена |
| `user_id` | `uuid` | NOT NULL, FK → `auth.users(id)` | Владелец токена |
| `token_hash` | `text` | NOT NULL, UNIQUE | Хеш opaque refresh-токена |
| `expires_at` | `timestamptz` | NOT NULL | Срок действия, около 30 дней |
| `revoked_at` | `timestamptz` | NULL | Время отзыва; токен действителен только при `NULL` и `expires_at > now()` |
| `created_at` | `timestamptz` | NOT NULL | Время выпуска |

Индекс `(user_id, expires_at)` нужен для выборки сессий пользователя по сроку
действия. Для очистки токенов всех пользователей по одному `expires_at`
его недостаточно; отдельный индекс оценивается по запросам очистки.
Исходный refresh-токен в БД не хранится. Ротация атомарно отзывает старую
запись и создаёт новую; два параллельных refresh не должны оба использовать
один токен. Logout отзывает только переданный refresh-токен.

### `auth.contacts`

| Поле | Тип | Ограничение | Назначение |
| --- | --- | --- | --- |
| `user_id` | `uuid` | PK, FK → `auth.users(id)` | Владелец списка контактов |
| `contact_id` | `uuid` | PK, FK → `auth.users(id)` | Добавленный пользователь |
| `created_at` | `timestamptz` | NOT NULL | Время добавления |

Составной первичный ключ `(user_id, contact_id)` исключает дубликаты.
`CHECK (user_id <> contact_id)` запрещает добавить самого себя. Контакты
однонаправленные: добавление A → B не создаёт автоматически B → A.
Повторный PUT не меняет существующую запись; DELETE удаляет только пару
текущего владельца. Удаление отсутствующей пары, включая свой ID, безопасно
и возвращает 204; попытку PUT самого себя auth отклоняет с 422 до вставки.
Удаление контакта не затрагивает таблицы history. Детали экрана и сортировки
согласованы в [#68](https://github.com/messenger-go-team/messenger/issues/68)
и закреплены в SPEC и auth OpenAPI через
[PR #72](https://github.com/messenger-go-team/messenger/pull/72).

`GET /contacts` выбирает контакты текущего владельца и сортирует их по
`username_normalized COLLATE "C" ASC` добавленного пользователя.
В ответе возвращается исходное написание `username`. Это соответствует
сортировке по возрастанию ASCII lower-case username в действующем контракте.

## Таблицы history

### `history.chats`

| Поле | Тип | Ограничение | Назначение |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | Идентификатор чата |
| `type` | `text` | NOT NULL, `personal` или `group` | Тип чата |
| `title` | `text` | NULL | Название, понадобится группам позже |
| `created_at` | `timestamptz` | NOT NULL | Время создания |
| `last_seq` | `bigint` | NOT NULL, DEFAULT 0, `0..9007199254740991` | Последний выданный номер сообщения |

Группы пока не реализуются, но `type` и `title` есть с первого дня, чтобы
личные чаты не пришлось переносить в другую модель на этапе 6.

### `history.chat_members`

| Поле | Тип | Ограничение | Назначение |
| --- | --- | --- | --- |
| `chat_id` | `uuid` | PK, FK → `history.chats(id)` | Чат |
| `user_id` | `uuid` | PK | UUID пользователя из auth |
| `role` | `text` | NOT NULL, `owner` или `member` | Роль в чате |
| `joined_at` | `timestamptz` | NOT NULL | Время вступления |
| `last_delivered_seq` | `bigint` | NOT NULL, DEFAULT 0, `0..9007199254740991` | Последняя подтверждённая доставка |
| `last_read_seq` | `bigint` | NOT NULL, DEFAULT 0, `0..9007199254740991` | Последнее прочитанное сообщение |

Первичный ключ `(chat_id, user_id)` одновременно запрещает дубли участников и
позволяет сообщению проверить, что отправитель состоит в этом чате. В T12
миграция добавит проверку `last_read_seq <= last_delivered_seq`; границы
`0 <= last_read_seq <= last_delivered_seq <= chats.last_seq` валидирует
history-сервис внутри транзакции. Межтабличную границу с `chats.last_seq`
нельзя обеспечивать обычным `CHECK`.

В MVP REST-read после показа сообщений продвигает `last_read_seq` и, если
нужно, `last_delivered_seq` до того же значения одним обновлением. Прочтение
подтверждает и доставку этому пользователю. Оба курсора только увеличиваются;
повтор или меньший seq их не уменьшает, seq выше `chats.last_seq` отклоняется
с 422. GET истории курсоры не меняет. Рассылка `message.read` собеседнику
остаётся этапом 2. Курсоры хранятся в диапазоне `0..9007199254740991`.

### `history.personal_chat_pairs`

Это служебная таблица для инварианта FR-CHAT-1. Она не заменяет
`chat_members`: права, список участников и рассылка всегда определяются по
`chat_members`.

| Поле | Тип | Ограничение | Назначение |
| --- | --- | --- | --- |
| `user_low_id` | `uuid` | PK | Меньший UUID пары пользователей |
| `user_high_id` | `uuid` | PK | Больший UUID пары пользователей |
| `chat_id` | `uuid` | NOT NULL, UNIQUE, FK → `history.chats(id)` | Личный чат пары |

`CHECK (user_low_id < user_high_id)` задаёт единственный канонический порядок
пары. При параллельном создании чата вставка одинаковой пары столкнётся с
составным PK; обработчик возвращает уже существующий чат. В одной транзакции
history создаёт `chats`, две строки `chat_members` и строку этой таблицы.
Ровно два участника, их соответствие канонической паре и `type = personal`
обеспечивает сервис в этой транзакции. PK/FK сами по себе не проверяют
число участников; изменение состава личного чата в MVP не предусмотрено.

### `history.messages`

| Поле | Тип | Ограничение | Назначение |
| --- | --- | --- | --- |
| `id` | `uuid` | PK | Серверный идентификатор сообщения |
| `chat_id` | `uuid` | NOT NULL, FK → `history.chats(id)` | Чат |
| `seq` | `bigint` | NOT NULL, `1..9007199254740991` | Порядковый номер внутри чата |
| `sender_id` | `uuid` | NOT NULL | Отправитель из `chat_members` |
| `client_msg_id` | `uuid` | NOT NULL | Идемпотентный ID от клиента |
| `body` | `text` | NOT NULL, длина 1-4096 | Текст сообщения |
| `created_at` | `timestamptz` | NOT NULL | Время сохранения |

Внешний ключ `(chat_id, sender_id)` → `history.chat_members(chat_id, user_id)`
не позволит сохранить сообщение от неучастника.
`seq` уникален только внутри чата, а `client_msg_id` - внутри пары
чат/отправитель. Они не являются глобально уникальными полями.
Предел `9007199254740991` соответствует `Number.MAX_SAFE_INTEGER` в history
OpenAPI. В T12 нужны соответствующие CHECK для seq и курсоров, чтобы из БД
не возвращались небезопасные JSON-числа. При достижении предела операция
сохранения завершается ошибкой без изменения `last_seq`.

## Индексы и инварианты

| Имя | Таблица | Определение | Причина |
| --- | --- | --- | --- |
| `users_username_normalized_uq` | `auth.users` | UNIQUE (`username_normalized`) | Уникальный username без учёта регистра |
| `refresh_tokens_user_expires_idx` | `auth.refresh_tokens` | (`user_id`, `expires_at`) | Выборка сессий пользователя по сроку действия |
| `chat_members_user_chat_idx` | `history.chat_members` | (`user_id`, `chat_id`) | Список чатов текущего пользователя; PK начинается с `chat_id` |
| `messages_chat_seq_uq` | `history.messages` | UNIQUE (`chat_id`, `seq` DESC) | Порядок и выборка истории по `chat_id`, `seq DESC` |
| `messages_idempotency_uq` | `history.messages` | UNIQUE (`chat_id`, `sender_id`, `client_msg_id`) | Повторная отправка не создаёт дубликат |
| `personal_chat_pairs_pkey` | `history.personal_chat_pairs` | PK (`user_low_id`, `user_high_id`) | Один личный чат на пару |

`messages_chat_seq_uq` одновременно обеспечивает уникальность `(chat_id, seq)`
и индекс для `ORDER BY seq DESC`. PostgreSQL B-tree может сканировать индекс в
обратном порядке; отдельный дублирующий индекс не нужен.
Для фиксированного `chat_id` этот индекс поддерживает обе границы
`seq < before_seq` и `seq > after_seq`. Последнюю и предыдущую страницы
выбирают по `seq DESC LIMIT`, а в ответе возвращают по возрастанию seq;
страницу after_seq выбирают сразу по `seq ASC LIMIT`.

Последнее сообщение чата берётся по максимальному seq. Непрочитанные считаются
по сообщениям с `seq > last_read_seq` и `sender_id <> текущий пользователь`,
как требует действующий history OpenAPI. Отдельные поля `last_message` и
`unread_count` в БД не нужны. Фактический план выборки через EXPLAIN
проверяется при реализации [#31](https://github.com/messenger-go-team/messenger/issues/31).

## Транзакции history

### Сохранение сообщения

1. Начать транзакцию и заблокировать строку чата через `SELECT ... FOR UPDATE`.
2. Проверить членство отправителя и найти `(chat_id, sender_id, client_msg_id)`.
3. При существующем сообщении вернуть исходные id, seq и created_at с
   признаком duplicate, не меняя `last_seq`.
4. Для нового сообщения увеличить `last_seq` на 1, вставить сообщение
   с этим seq и завершить транзакцию. При ошибке откатить обе записи.

Блокировка сериализует назначения seq в одном чате. Для счётчика не
используется PostgreSQL sequence: его значения не откатываются вместе
с транзакцией. На повторах и откатах счётчик чата не продвигается.

Это сохраняет серверный порядок и даёт эффект «ровно один раз» при повторах
клиента, хотя доставка от клиента до сервера остаётся «минимум один раз».

### Создание личного чата

1. Проверить второго пользователя через внутренний auth-метод.
2. Отклонить совпадение пользователей и привести пару к порядку UUID,
   совпадающему с PostgreSQL `uuid` comparison.
3. В транзакции создать `chats` с `type = personal` и двух участников,
   затем вставить `personal_chat_pairs`. Такой порядок соблюдает FK на чат.
4. При конфликте PK пары откатить всю транзакцию, включая новый чат и
   участников, затем отдельным запросом получить существующий `chat_id`.
   Нельзя продолжать запросы в транзакции после ошибки unique violation.
5. При успехе зафиксировать транзакцию. Незавершённые чаты и лишние участники
   после конкурирующих запросов не остаются.

### Прочтение

В транзакции проверить существование чата, членство и `seq <= last_seq`.
Одним UPDATE строки участника установить
`last_read_seq = GREATEST(last_read_seq, N)` и
`last_delivered_seq = GREATEST(last_delivered_seq, N)`.
Ответ 204 отправляется после commit. Все будущие обработчики delivered/read
также используют монотонные обновления, чтобы запоздалое событие не откатило
курсоры и не нарушило CHECK.

## Ссылки на PostgreSQL

- [Ограничения CHECK, UNIQUE и FK](https://www.postgresql.org/docs/18/ddl-constraints.html).
- [B-tree и ORDER BY](https://www.postgresql.org/docs/18/indexes-ordering.html).
- [Изоляция транзакций и особенности sequence](https://www.postgresql.org/docs/18/transaction-iso.html).

## Дальше

T12 перенесёт эту схему в `services/auth/migrations` и
`services/history/migrations`, добавит `up`/`down` миграции и проверит их на
чистой PostgreSQL.
