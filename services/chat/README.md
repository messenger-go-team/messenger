# Chat

WebSocket-эндпоинт /ws из [#33](https://github.com/messenger-go-team/messenger/issues/33)
по [контракту WebSocket v1](../../api/ws/events.md).
Транспорт реализован в #33, хаб и рассылка серверных событий - в #34.
Chat обрабатывает `message.send`, передаёт автора из access JWT и сохраняет
сообщение через `History.SaveMessage`. После commit Chat отправляет `message.ack`
исходному сокету и `message.new` всем подключённым вкладкам участников.
Повтор с тем же `client_msg_id` и тем же текстом возвращает метаданные исходной
записи. Если уведомление пропущено, сообщение доступно через REST History.

## Запуск

Из корня репозитория соберите и запустите сервис:

    make build SERVICE=chat
    JWT_SECRET="<общий секрет HS256, минимум 32 байта>" \
      WS_ALLOWED_ORIGINS="http://localhost:5173,http://127.0.0.1:5173" \
      HTTP_ADDR=127.0.0.1:8080 ./bin/chat

Настройки общие с [шаблоном Go-сервиса](../_template/README.md).
SERVICE_NAME по умолчанию равен chat. Обязательный WS_ALLOWED_ORIGINS -
список HTTP(S) origins через запятую. Указывайте схему, хост и порт
в том виде, в каком их присылает браузер, без пути и конечного слеша.
`HISTORY_GRPC_ADDR` задаёт приватный `host:port` History (по умолчанию
`history:9090`). При запуске обоих сервисов в WSL укажите адрес слушателя
History, например `127.0.0.1:9090`. `HISTORY_RPC_TIMEOUT` ограничивает вызов
History и по умолчанию равен `3s`.

`/readyz` проверяет готовность History через приватный gRPC health
на том же адресе с таймаутом в одну секунду. Если History недоступен
или его хранилище не готово, Chat возвращает `503`. `/healthz` проверяет
жизнеспособность процесса Chat.

В DevTools на разрешённом origin откройте соединение с действующим
access JWT, выпущенным с тем же JWT_SECRET:

    const ws = new WebSocket("ws://127.0.0.1:8080/ws", ["messenger.v1", "bearer." + accessToken])
    ws.onopen = () => console.log(ws.protocol)
    ws.onclose = ({ code }) => console.log(code)

Ожидаемый протокол - messenger.v1. Ctrl+C на сервере отправляет Close 1001.
При истечении токена сервер отправляет Close 4401.
Один WebSocket-message ограничен 64 KiB. Сервер отправляет Ping каждые
25 секунд, ждёт соответствующий Pong до 10 секунд и ограничивает запись
каждого кадра 10 секундами. При переполнении очереди из 32 событий сервер
отключает медленное соединение с Close 1013, если транспорт ещё позволяет
записать управляющий кадр. Клиент восстанавливает данные через REST history.

## Рассылка

Chat регистрирует соединение по `sub` проверенного access JWT и удаляет его
при закрытии. `/metrics` содержит gauge `chat_active_websocket_connections`,
который считает соединения, включая несколько вкладок одного пользователя.

Для серверного события `broadcastChat` вызывает `GetChatMembers` от имени
проверенного пользователя. Брокер в памяти ставит событие в очередь каждого
открытого сокета из полученного списка. Ошибка History прерывает рассылку.
События для офлайн-пользователей не буферизуются.

    curl -i http://127.0.0.1:8080/healthz
    curl -i http://127.0.0.1:8080/readyz
    curl -sS http://127.0.0.1:8080/metrics | grep '^chat_active_websocket_connections '
    go test -race -count=1 ./services/chat

WebSocket можно открыть с тестовым JWT без PostgreSQL и Redis. Для определения
участников при рассылке нужен доступ к gRPC History по приватной сети.
