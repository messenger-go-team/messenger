# Сквозные проверки Messenger в Chromium

Playwright открывает собранное приложение под `/app/`. Nginx направляет REST и WebSocket на Auth, History и Chat внутри одного проекта Compose. Каждый тест создаёт уникальные аккаунты. Два участника переписки входят в отдельных браузерных контекстах.

## Что проверяется

- **Вход.** Пользователь входит через форму приложения и получает доступ к своей сессии.
- **История после перезагрузки.** Сообщение, отправленное через интерфейс, сохраняется в History и появляется в открытом заново чате без дубля.
- **Безопасный повтор.** Клиент A теряет подтверждение уже сохранённой отправки. После переподключения он повторяет отправку с прежним `client_msg_id` и новым ID попытки. Подтверждение содержит прежние серверные `message_id` и `seq`. В чате и истории остаётся одна запись.

Четвёртый сценарий проверит видимые отправителю статусы доставки и прочтения после интеграции T135. [T138](https://github.com/messenger-go-team/messenger/issues/138) · [T135](https://github.com/messenger-go-team/messenger/issues/135)

## Локальный прогон

Потребуются Docker Compose с Linux-контейнерами и Node.js 24.16.0, как в CI. Из корня репозитория установите зависимости и Chromium.

```powershell
Push-Location qa/e2e
try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    npx --no-install playwright install chromium
    if ($LASTEXITCODE -ne 0) { throw 'Chromium installation failed' }
} finally {
    Pop-Location
}
```

Следующие команды создают отдельный проект с динамическим портом на `127.0.0.1`. Каждый запуск тестов создаёт новые фикстуры через Auth и History.

```powershell
$project = "qa138-" + [guid]::NewGuid().ToString("N")
$composeArgs = @("compose", "-p", $project, "-f", "qa/e2e/compose.yaml")
try {
    docker @composeArgs up -d --build --wait --wait-timeout 120
    if ($LASTEXITCODE -ne 0) { throw 'Compose startup failed' }
    $gateway = docker @composeArgs port gateway 8080
    if ($LASTEXITCODE -ne 0) { throw 'Gateway port unavailable' }
    $env:E2E_BASE_URL = "http://" + $gateway.Trim()

    foreach ($run in @("run-1", "run-2")) {
        $env:E2E_RUN = $run
        npm --prefix qa/e2e test
        if ($LASTEXITCODE -ne 0) { throw "Playwright failed in $run" }
    }
} finally {
    docker @composeArgs down --volumes --remove-orphans
    Remove-Item Env:E2E_RUN, Env:E2E_BASE_URL -ErrorAction SilentlyContinue
}
```

## CI и диагностика

Workflow отводит десять минут с первого шага job до завершения второго прогона. В это время входят установка инструментов, сборка, готовность Compose и оба прохода тестов. Длительности запуска стенда и браузерных прогонов выводятся отдельно. После замера workflow сохраняет диагностику и удаляет выделенный стенд. [Workflow](../../.github/workflows/playwright-e2e.yml)

Для каждого прохода Playwright пишет отдельный JUnit и при падении сохраняет trace и PNG в `qa/e2e/test-results/`. При локальном разборе откройте нужный `trace.zip` командой `npx --no-install playwright show-trace <путь-к-trace.zip>` из `qa/e2e`. Проверка опубликованного staging проводится отдельно.

## Результат на 28 ноября 2026

На Windows с Docker Desktop (Linux containers) три сценария прошли четыре раза без пропусков. Первые два прогона заняли вместе 35,25 с. После пересоздания проекта с пустой БД сборка и ожидание готовности заняли 3 мин 37,59 с, следующие два прогона — 33,70 с. Полный второй замер от запуска Compose до окончания тестов составил 4 мин 11,78 с. Node-зависимости тестов и Chromium на машине уже были установлены.

Отдельное намеренное падение проверки создало читаемый Playwright trace и PNG-снимок страницы. Длительность GitHub Actions предстоит измерить при первом запуске workflow.
