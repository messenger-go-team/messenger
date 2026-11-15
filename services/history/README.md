# History

[#30](https://github.com/messenger-go-team/messenger/issues/30): создание личного
чата по REST и чтение текущего членства по внутреннему gRPC.
Контракты: [History OpenAPI](../../api/openapi/history.yaml),
[history.proto и правила ошибок](../../api/proto/README.md).
Используется существующая миграция #12, схема БД не меняется.

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
`POST /chats/personal` без замены исходного URI.

## Состояние, логи и завершение

HTTP сохраняет request_id, panic recovery и /metrics из шаблона.
/healthz проверяет процесс. /readyz проверяет схему трёх таблиц,
SELECT/INSERT и UPDATE для chats; без миграции/прав даёт 503.
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

## Подключение #29 и #31

SaveMessage пока возвращает стандартный UNIMPLEMENTED. Для #29 добавить
отдельный метод SaveMessage на historyGRPC и внедрить репозиторий сообщений;
повторно регистрировать HistoryService не нужно. Membership-методы лежат
в membership_grpc.go, операции пар - internal/postgres/chats.go.

Список чатов, история и курсор прочтения относятся к #31. Контракт не менялся.
Для #36/#38 проверить маршрутизацию, HTTPS/JWT и недоступность внутреннего
порта через внешний домен. Локальные тесты не заменяют QA на staging.
