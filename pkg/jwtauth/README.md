# Общая проверка access JWT

Пакет реализует [#25](https://github.com/messenger-go-team/messenger/issues/25)
по [auth OpenAPI](../../api/openapi/auth.yaml),
[WS-контракту](../../api/ws/events.md) и [SPEC](../../docs/SPEC.md).

Проверяются подпись HS256, обязательные claims `sub`, `iat`, `exp`,
истечение `exp`, отсутствие будущего `iat` и допустимость необязательного
`nbf`. Другие алгоритмы, включая none, отклоняются. Временные claims имеют
тип JSON number. `sub` должен быть ненулевым UUID в форме 36 символов
с дефисами; версия UUID не ограничена. В Identity UUID нормализуется
в нижний регистр. Ошибки проверки возвращают только ErrInvalidToken,
без токена и внутренних подробностей.

Имена claims регистрозависимы; повторяющиеся имена отклоняются, включая
имена с эквивалентными JSON escape-последовательностями. Дробные даты
сохраняются с точностью `time.Time`; более мелкие доли округляются вверх
до наносекунды для корректного сравнения с текущим временем.
Поддерживаются даты в годах 0001-9999, числовая запись до 128 байт
и десятичный показатель степени от -1000 до 1000.
Наличие `crit` отклоняется: критические расширения JWS не поддерживаются.
Наличие `b64` также отклоняется независимо от значения: профиль JWT
использует обычный base64url payload. Декодированные заголовок и claims
проверяются на валидный UTF-8 до разбора JSON.
Пробельные символы в compact JWT запрещены непосредственно в `Verify`.

## Конфигурация

Все сервисы используют одинаковый `JWT_SECRET` из окружения процесса.
Минимум - 32 байта, без автоматического trim или декодирования.
Пакет не имеет ключа по умолчанию и сам не читает `.env`.
Отсутствующий или короткий секрет приводит к ошибке при создании verifier.
Например, для локального запуска можно сгенерировать секрет:

```bash
export JWT_SECRET="$(openssl rand -hex 32)"
```

Один сгенерированный секрет передаётся всем сервисам. В `.env.example`
`JWT_SECRET` оставлен пустым: перед запуском необходимо задать свой ключ.
Секрет не передаётся фронтенду и не помещается в переменные VITE_*.

```go
verifier, err := jwtauth.NewFromEnv()
if err != nil {
    // Завершить запуск с ошибкой; не подменять секрет значением по умолчанию.
    return err
}
```

При собственном загрузчике конфигурации используйте `jwtauth.New(secret)`.
В шаблоне сервиса loadConfig делает именно это, сохраняя тестируемое
чтение окружения и проверку конфигурации до запуска listener.

## HTTP middleware

```go
application := http.NewServeMux()
application.HandleFunc("GET /private", func(w http.ResponseWriter, r *http.Request) {
    identity, ok := jwtauth.FromContext(r.Context())
    if !ok {
        // На защищённом маршруте middleware уже должен установить identity.
        http.Error(w, "unauthorized", http.StatusUnauthorized)
        return
    }
    // identity.UserID - пользователь из проверенного JWT.
    // Затем проверить его права на конкретный ресурс.
    _ = identity
    w.WriteHeader(http.StatusNoContent)
})
protected := verifier.Middleware(application)
```

Импорты примера: `net/http` и
`github.com/messenger-go-team/messenger/pkg/jwtauth`.
`/private` - пример подключения, не новый маршрут публичного API проекта.

Middleware принимает один заголовок Authorization с Bearer credentials.
Имя схемы регистронезависимо; между схемой и токеном допустимы пробелы.
Повторяющиеся/объединённые заголовки отклоняются. Access token из query
или cookie не используется.

При ошибке ответ - 401, JSON ApiError с code=unauthorized,
WWW-Authenticate: Bearer и Cache-Control: no-store. Защищённый handler
не вызывается. Middleware не оборачивает ResponseWriter, поэтому само
подключение не убирает возможности Flush/Hijack.

В services/_template middleware уже подключён к прикладному mux;
health/readiness/metrics обслуживаются отдельно. При копировании шаблона
добавляйте защищённые обработчики в application. Публичные auth-маршруты
регистрации, входа, refresh и logout нужно монтировать отдельно от этого
middleware: refresh/logout используют собственную refresh-cookie.
JWT сам по себе не доказывает участие в чате или право доступа к ресурсу.
Пакет не обращается к БД: существование пользователя и дополнительные
ограничения доступа проверяет владелец операции.

## Проверка для WebSocket

Chat извлекает токен из согласованного `Sec-WebSocket-Protocol`, затем
вызывает `verifier.Verify(rawToken)` до HTTP 101. Возвращаемая Identity
содержит UserID и ExpiresAt: chat использует exp для ограничения жизни
авторизованного соединения. HTTP Bearer middleware не является парсером
WS subprotocol. Origin allowlist, выбор messenger.v1 и закрытие с 4401
при истечении токена реализуются в задаче WebSocket-сервиса.

Проверка выполняется без leeway: при now >= exp токен недействителен.
Выпуск токенов, время жизни около 15 минут и refresh-ротация относятся
к auth в #27. Пакет не ограничивает срок токена отдельной константой
и не реализует немедленный отзыв access JWT после logout.
Issuer/audience не обязательны, поскольку текущий контракт их не задаёт.

## Проверки

```bash
go test ./pkg/jwtauth ./services/_template
go test -race ./pkg/jwtauth ./services/_template
```

Покрыты валидный/просроченный/подделанный JWT, чужие алгоритмы, none,
обязательные claims и их типы, UUID, отсутствующий/короткий секрет,
неоднозначные HTTP credentials, контекст и параллельная проверка.
Тест шаблона проверяет чтение конфигурации и подключение middleware
в общем HTTP-стеке с сохранением служебных маршрутов и request_id.

Основание настройки библиотеки:
[golang-jwt: parsing and validation](https://golang-jwt.github.io/jwt/usage/parse/).
