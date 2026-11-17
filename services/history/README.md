# History

[#30](https://github.com/messenger-go-team/messenger/issues/30): создание личного
чата по REST и чтение текущего членства по внутреннему gRPC.
[#29](https://github.com/messenger-go-team/messenger/issues/29): транзакционное
сохранение сообщений через SaveMessage.
[#31](https://github.com/messenger-go-team/messenger/issues/31): список чатов,
курсорная история и приватная отметка прочтения по REST.
Контракты: [History OpenAPI](../../api/openapi/history.yaml),
[history.proto и правила ошибок](../../api/proto/README.md).
Базовая схема принадлежит миграции #12; #86 добавляет личные записи миграцией
`000002_later_entries`, не переписывая уже применённую версию 1.

## Запуск

Из корня проекта применить миграцию History отдельно от запуска приложения:

```bash
make migrate-up MIGRATE_SERVICE=history
make build SERVICE=history
HTTP_ADDR=127.0.0.1:8082 GRPC_ADDR=127.0.0.1:9090 ./bin/history
```

Переменные окружения процесса (`.env` автоматически не загружается):

| Переменная | Значение по умолчанию | Назначение |
| --- | --- | --- |
| HISTORY_DATABASE_URL | нет | Обязательный PostgreSQL URL/DSN |
| JWT_SECRET | нет | Общий HS256-секрет Auth/Chat/History, минимум 32 байта |
| AUTH_INTERNAL_TOKEN | нет | Секрет History -> Auth lookup, тот же у Auth; отличается от JWT_SECRET, минимум 32 печатных ASCII-байта без пробелов |
| AUTH_BASE_URL | http://auth:8080 | Origin внутреннего Auth без credentials/query/пути |
| HTTP_ADDR | :8080 | HTTP listener |
| GRPC_ADDR | :9090 | Внутренний gRPC listener |
| SERVICE_NAME | history | Поле service в JSON-логах |
| LOG_LEVEL | INFO | Уровень slog |
| SHUTDOWN_TIMEOUT | 10s | Общий срок завершения двух серверов |

Для локального Auth задайте `AUTH_BASE_URL=http://127.0.0.1:8081` и тот же
`AUTH_INTERNAL_TOKEN`, что у Auth. Общий порядок передачи секрета до выката
описан в [deploy README](../../deploy/README.md).
Внутренний HTTP не шифруется; внутренний TLS/mTLS согласуется отдельно.

## Создание чата

`POST /chats/personal`, `Authorization: Bearer <access JWT>`, JSON
`{"user_id":"<UUID собеседника>"}`. Владелец берётся из JWT; неизвестные,
повторные и отсутствующие поля JSON отклоняются, лимит тела 1 MiB.
Требуется Content-Type application/json. Самому себе чат создать нельзя.

History проверяет обоих пользователей через служебный lookup Auth, затем
создаёт чат, двух участников и personal_chat_pairs в одной транзакции.
Канонически упорядоченная пара защищена transaction advisory lock;
уникальный ключ пары остаётся ограничением БД. Конкурентное создание,
включая запросы с обеих сторон, даёт один чат без лишних строк.

Первый ответ - 201, повторный - 200 с тем же id и created_at; last_seq читается
из БД. В ответе только Chat из OpenAPI, usernames сохраняют написание Auth,
участники упорядочены по UUID. Чаты не зависят от наличия в контактах.
Членство существующего личного чата не восстанавливается автоматически:
нарушение инварианта двух участников даёт безопасную ошибку зависимости.

Неверный JWT или удалённый владелец - 401, отсутствующий собеседник - 404,
неверный UUID/JSON/self - 422. Отказ Auth, неверный служебный credential,
redirect или некорректный ответ lookup не превращаются в отсутствие
пользователя: возвращается 503 с ApiError. Только JSON 404 с кодом
user_not_found подтверждает отсутствие пользователя. Клиент использует
собственный HTTP transport с Proxy: nil, поэтому HTTP_PROXY/HTTPS_PROXY
из окружения не получают служебный секрет. Нет автоматического повтора
записи после неопределённого результата commit; клиент может повторить
создание той же пары. Ошибки не содержат SQL, DSN и credentials.

## Внутренние RPC

- GetChatMembers проверяет requester_id и выдаёт текущие ID по UUID:
  постороннему PERMISSION_DENIED, отсутствующий чат NOT_FOUND.
- CheckMembership даёт false для постороннего в существующем чате;
  отсутствующий чат NOT_FOUND. Ошибка БД - UNAVAILABLE, не false.
- Оба метода требуют канонические UUID в нижнем регистре, кроме nil UUID.
  Невалидные параметры дают INVALID_ARGUMENT; отмена/deadline сохраняют
  CANCELLED/DEADLINE_EXCEEDED.

Это снимок членства. В #29 SaveMessage должен самостоятельно проверять
членство в транзакции сохранения, согласно protobuf-контракту.

RPC доступны только доверенному Chat во внутренней сети: идентичность
берётся Chat из проверенного JWT. В этой версии нет service credentials
для Chat -> History; контракт относит их выбор к развёртыванию.
В локальной Docker-проверке gRPC-клиент по имени history укладывается в
трёхсекундный deadline с `grpc.WithDisableServiceConfig()` и `grpc.WithNoProxy()`.
Эти настройки отключают поиск DNS service-config и proxy для внутреннего
соединения. При подключении Chat в #35 проверить их вместе с DNS окружения;
в #38 повторить проверку на стенде.
Порт gRPC не публиковать наружу или через Nginx. HTTP health/readiness/metrics
также предназначены для внутренней сети. Публичный маршрут для #36:
`POST /chats/personal`, `GET /chats`, `GET /chats/{chat_id}/messages` и
`POST /chats/{chat_id}/read` без замены исходного URI.

## Состояние, логи и завершение

HTTP сохраняет request_id, panic recovery и /metrics из шаблона.
/healthz проверяет процесс. /readyz проверяет схему четырёх таблиц и SELECT/INSERT,
UPDATE(last_seq) для chats и UPDATE(last_read_seq, last_delivered_seq)
для chat_members; без миграции/прав даёт 503.
Готовность восстанавливается после исправления БД без перезапуска.
Auth вызывается при создании чата; его временный отказ отражается в ответе
операции 503 и не блокирует чтение членства по gRPC.

HTTP и gRPC обслуживаются одним процессом. SIGTERM снимает readiness,
одновременно запускает HTTP Shutdown и gRPC GracefulStop. При истечении
общего срока соединения закрываются принудительно, процесс завершается с
ошибкой. При штатной остановке код 0. Логи не включают payload, query,
credentials или SQL-ошибки; gRPC возвращает x-request-id в metadata.

## Проверки

```bash
make test
make lint
HISTORY_TEST_DATABASE_URL='postgres://test_user:test_password@127.0.0.1:15432/postgres?sslmode=disable' go test -race -count=1 ./services/history/...
```

Интеграционные тесты требуют отдельный PostgreSQL и роль с CREATEDB.
Создают и удаляют собственную БД history_test_*, не меняют таблицы БД из URL.
Без переменной пропускаются; CI передаёт её вместе с PostgreSQL 18.
Проверяются реальный HTTP/gRPC, конкурентная пара, отозванное членство,
ошибки Auth/БД, rollback, deadline под блокировкой, config и lifecycle.

## SaveMessage (#29)

Запрос: канонические ненулевые chat_id/sender_id, UUID v4 client_msg_id и
исходный UTF-8 body (1..4096 code points, не только Unicode White_Space,
без U+0000). Пробелы, переносы строк и Unicode-последовательность сохраняются.
Chat берёт sender_id только из проверенного JWT. History проверяет запрос
самостоятельно; Auth при SaveMessage не вызывается, права определяются
текущей строкой history.chat_members.

Транзакция блокирует чат FOR UPDATE, затем членство FOR KEY SHARE и ищет
(chat_id,sender_id,client_msg_id). Идентичный повтор возвращает исходные
message_id/seq/created_at с duplicate=true. Другой body с тем же ключом
даёт ALREADY_EXISTS. Повторы и конфликты не продвигают last_seq.

Только для нового сообщения проверяется предел 9007199254740991,
увеличивается last_seq и вставляется сообщение с серверным UUID и
clock_timestamp() БД. Обе записи фиксируются одним commit. PostgreSQL
sequence не используется. Ответ OK возвращается после успешного commit.

Членство проверяется и блокируется при каждом сохранении, включая повтор.
Предварительный CheckMembership остаётся снимком. Для блокировки строки
PostgreSQL требует UPDATE хотя бы одного столбца chat_members
([правила SELECT](https://www.postgresql.org/docs/18/sql-select.html)).
Пример минимального дополнения к SELECT/INSERT после #31: UPDATE(last_seq)
для chats и UPDATE(last_read_seq, last_delivered_seq) для chat_members. Эти права
также позволяют блокировать членство в SaveMessage. Readiness проверяет их,
а также наличие полей и SELECT/INSERT таблицы messages.

Ошибки: INVALID_ARGUMENT для входных данных, NOT_FOUND для отсутствующего
чата, PERMISSION_DENIED для постороннего, ALREADY_EXISTS для конфликта
идемпотентности, OUT_OF_RANGE для нового сообщения за пределом seq.
Отмена/deadline сохраняют CANCELLED/DEADLINE_EXCEEDED; сбой БД даёт UNAVAILABLE.
Ошибки не возвращают исходный текст, metadata сообщения, SQL или credentials.
Некорректные сохранённые metadata не выдаются как OK (DATA_LOSS).

При потере ответа, timeout или разрыве результат commit может быть неизвестен.
Повторяют прежние chat_id/sender_id/client_msg_id и точный body; новый ключ
означает новое сообщение. History не выполняет автоматический повтор записи.
Политика backoff/jitter вызывающего Chat описана в protobuf-контракте для #35.

SaveMessage реализован в messages_grpc.go, правила входа - internal/messages,
SQL - internal/postgres/messages.go. Сохранение и рассылка не атомарны:
в #35 ack строится из подтверждённого ответа, а потеря рассылки восстанавливается
историей. Список чатов, история и курсор прочтения реализованы в #31, см. ниже.

Дополнительные тесты #29: 100 новых сообщений, конкурентные одинаковые ключи
и конфликты body, Unicode/границы, последняя seq и повтор на пределе,
ошибка INSERT и deferred commit, потеря ответа после commit, отмена SQL
под блокировкой, отзыв членства до сохранения/повтора и ограниченная DB-роль.
Тест отзыва членства при сохранённом сообщении снимает FK только в отдельной
одноразовой тестовой БД; миграция приложения остаётся без изменений.

Для #36/#38 проверить маршрутизацию, HTTPS/JWT и недоступность внутреннего
порта через внешний домен. Локальные тесты не заменяют QA на staging.

## Хранение «Вернуться позже» (#86)

Миграция History версии 2 создаёт later_entries: владелец, ссылка на сообщение,
nullable due_at timestamptz, active/done и серверные timestamps. Частичный UNIQUE
(user_id,message_id) WHERE state='active' и атомарный ON CONFLICT DO UPDATE
гарантируют одну активную запись без SELECT-before-INSERT. Повтор сохраняет ID
и created_at, заменяет срок; после done новое сохранение получает другой ID.

postgres.LaterRepository предоставляет Save и Complete без HTTP-маршрутов.
Save принимает chat_id для проверки принадлежности message_id; owner должен
поступать из проверенного JWT при подключении #87. До первой блокировки обычный
SELECT проверяет членство и принадлежность сообщения чату: недоступный источник
даёт ErrNotFound, не дожидаясь FOR UPDATE обычного SaveMessage. Транзакции явно
используют Read Committed. Затем чат, актуальное членство и сообщение повторно
проверяются и блокируются через FOR KEY SHARE в этом порядке до commit.
Предварительный снимок не заменяет проверки после ожидания блокировки. Чужая запись,
потеря доступа, отсутствующий источник или несовпавший chat/message возвращают
одну later.ErrNotFound без Entry. Завершение проверяет доступ и для done;
повтор по старому ID не затрагивает новую активную запись того же сообщения.

FK на messages с ON DELETE CASCADE не оставляет сирот после физического удаления
источника. FK на членство владельца нет: отзыв доступа сохраняет запись, которую
API #87 должен скрывать и снова выдавать при восстановлении доступа. Текст
сообщения не копируется, last_seq/read/delivered и состояние собеседника не меняются.
Нет Redis, фоновой очереди напоминаний и пользовательских папок.

DueTime проверяет typed time.Time на UTC-диапазон 0001..9999 и точность до
микросекунды, не округляя более точный срок. Прошлое время и null допустимы.
Строгий разбор сырой RFC3339-строки, включая невозможные даты, год 0000 и LF/CRLF,
остаётся HTTP-обязанностью #87; эта typed проверка его не заменяет.

Отдельная LaterRepository.Ready проверяет schema/grants хранилища. Для row lock
источников необходим UPDATE хотя бы одного столбца chats/chat_members/messages;
минимальное дополнение к правам #29: UPDATE(id) для messages. На later_entries
достаточно SELECT/INSERT и UPDATE(due_at,state,updated_at); DELETE не нужен.
#87 подключит эту проверку к общей readiness вместе с реальным API. Пока endpoints
не используют Later, действующие #29-маршруты не зависят от новой таблицы.

Мигратор применяет версию 2 обычным `make migrate-up MIGRATE_SERVICE=history`.
`make migrate-down MIGRATE_SERVICE=history MIGRATE_STEPS=1` откатывает только
Later и уничтожает его записи, сохраняя сообщения/участников версии 1. Для полного
отката History после v2 нужны две ступени; auth по-прежнему имеет одну. Up/down
проверены через настоящий мигратор на БД с существующими сообщениями; при ошибке
DDL объекты приложения откатываются, журнал остаётся dirty для явной диагностики.

Интеграционные тесты используют только новые БД по HISTORY_TEST_DATABASE_URL;
MIGRATE_TEST_DATABASE_URL включает тесты мигратора в отдельной БД. Проверяются
64/32 конкурентных сохранения, оба порядка Save/Done, стабильные metadata,
владельцы, отзыв/возврат доступа, удержание источника до commit, отмена SQL,
ошибка deferred commit, ограничения и ограниченная runtime-роль. Дополнительно
проверяются отказ до ожидания строки чата и удаление членства/сообщения/чата после
предварительного SELECT. Тест удержания источника использует серверный lock_timeout:
пробные DELETE должны получить PostgreSQL SQLSTATE 55P03; каждая пробная транзакция
явно откатывается. Отмена клиентского context не считается доказательством блокировки.

Для #87: реализовать список с JOIN актуального членства, серверное время из БД
один раз на ответ, status/порядок по контракту и reschedule только active записи.
Поле user_id и state Entry является внутренним и не выдаётся как публичный DTO.
Обработчик не должен возвращать пустой список при отказе БД. В #38/#50 проверяется
двухаккаунтный сценарий на реальном staging; локальная БД его не заменяет.
