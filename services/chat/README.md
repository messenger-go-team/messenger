# Chat

WebSocket-эндпоинт /ws из [#33](https://github.com/messenger-go-team/messenger/issues/33)
по [контракту WebSocket v1](../../api/ws/events.md).
В #33 реализован транспорт. Рассылку добавляет #34, обработку команд
и сохранение сообщений добавляет #35.

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

В DevTools на разрешённом origin откройте соединение с действующим
access JWT, выпущенным с тем же JWT_SECRET:

    const ws = new WebSocket("ws://127.0.0.1:8080/ws", ["messenger.v1", "bearer." + accessToken])
    ws.onopen = () => console.log(ws.protocol)
    ws.onclose = ({ code }) => console.log(code)

Ожидаемый протокол - messenger.v1. Ctrl+C на сервере отправляет Close 1001.
При истечении токена сервер отправляет Close 4401.
Один WebSocket-message ограничен 64 KiB. Сервер отправляет Ping каждые
25 секунд, ждёт соответствующий Pong до 10 секунд и ограничивает запись
своих управляющих кадров 10 секундами.

    curl -i http://127.0.0.1:8080/healthz
    curl -i http://127.0.0.1:8080/readyz
    go test -race -count=1 ./services/chat

Chat в #33 можно запустить с тестовым JWT без PostgreSQL и Redis.
