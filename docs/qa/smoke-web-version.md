# T51: сверка версии загруженного веб-клиента

Эта процедура используется на старте SMK-01 и при финальной сверке [smoke](smoke.md), в обоих независимых профилях A/B. Подготовка эталона выполняется до таймера; получение и сравнение фактически загруженных файлов — внутри замера. Backend сверяется отдельно по smoke.md.

## Что передаёт владелец frontend-выката

Ответственный за публикацию frontend передаёт QA до прогона:

- URL успешного CI run, ссылку на конкретный архив опубликованного `dist`, SHA-256 архива и полный commit SHA, из которого собран этот артефакт. Если CI собирал merge ref, указать именно его SHA и отдельно head PR. Имя ветки, latest и SHA backend не подходят.
- Подтверждение, что опубликован именно этот архив, время публикации с TZ и URL веб-клиента. При пересборке того же commit эталоном остаётся фактически опубликованный артефакт, а не новая локальная сборка.
- Эталонный каталог SHA-256 файлов dist в JSON вида ниже. Ключи — публичные URL-path, значения — SHA-256 исходных байтов распакованных файлов. В `required` перечислены index.html и стартовые JS/CSS из него; в `files` — также все ленивые JS/CSS-чанки. Служебные токены и конфигурацию с секретами в каталог не включать.
- Контакт оператора и источник оперативного подтверждения активного релиза/backend за proxy. На период smoke согласовать отсутствие выката/отката и наблюдение за изменениями: совпадение только стартовых и конечных хешей не исключает промежуточный откат и возврат.

```json
{
  "frontend_sha": "<полный SHA сборки из CI>",
  "origin": "https://staging.tidingm.ru",
  "files": {
    "/app/index.html": "<SHA-256 dist/index.html>",
    "/app/assets/index-EXAMPLE.js": "<SHA-256 файла JS>",
    "/app/assets/index-EXAMPLE.css": "<SHA-256 файла CSS>"
  },
  "required": ["/app/index.html", "/app/assets/index-EXAMPLE.js", "/app/assets/index-EXAMPLE.css"]
}
```

QA скачивает архив, проверяет его SHA-256, распаковывает и сверяет каталог (`Get-FileHash -Algorithm SHA256 <файл>`). Готовит локальные пути `expected.json`, `A.har`, `B.har` и команду сравнения ниже; проверяет её до таймера на учебном HAR. Подготовленный эталон одинаков на старте и финише. Нет архива, полного SHA или подтверждения публикации — Blocked. `/app/version.json` и `/app/.vite/manifest.json`, возвращающие HTML SPA, не являются manifest версии. Будущий настоящий JSON версии можно использовать только после проверки его формата и связи с тем же dist; сейчас его наличие не предполагается.

## Как получить файлы именно из браузера

1. До таймера в обоих профилях открыть DevTools Network, включить Preserve log и Disable cache, подготовить экспорт HAR **с содержимым ответов**. Подготовить новую пустую запись для старта; само открытие приложения относится к SMK-01 и происходит после включения секундомера.
2. В SMK-01 открыть веб-клиент в A/B. Экспортировать стартовые HAR и сравнить публичные document/JS/CSS-ответы с эталоном. Это ответы реально выполненной браузером загрузки, а не отдельный curl/fetch к тому же URL. Совпадение одного имени bundle или HTML root недостаточно.
3. На финише сохранить исходные Network/WS-доказательства, затем после полного окна SMK-10 перед предусмотренным reload начать свежую Network-запись в A/B. Перезагрузить защищённые страницы с Disable cache, дождаться экрана входа и сохранить новые HAR. Финальная запись не должна содержать только старые ответы из начала прогона. Сравнить с тем же эталоном; все эти действия, ожидания и сверка входят в таймер. Для Service Worker/network override убедиться, что нет подмены ответов; если нельзя установить источник файлов, Blocked.
4. В каждой записи должны быть document и стартовые JS/CSS из `required`. Все дополнительные загруженные JS/CSS должны входить в каталог и совпадать. Ленивые чанки, загруженные при SMK-02…09, также сверять при их появлении с тем же эталоном; сохранить промежуточный HAR до очистки лога на финише. При смене/неизвестном хеше прервать прогон. Не требуется искусственно загрузить каждый ленивый чанк dist.

HAR может содержать пароли, Authorization, Cookie, Set-Cookie и тела приватных ответов даже при экспорте с названием «sanitized». Сырые HAR хранить только в закрытом локальном каталоге; в Git/PR их не прикладывать. Публиковать только результат сравнения, время, публичные пути/хеши и очищенные доказательства.

## Подготовленная команда сравнения

Пример для PowerShell 7: до таймера сохранить функцию в локальный `Compare-SmokeWeb.ps1`, подставить пути, проверить экспорт на учебной записи. Команда читает HAR локально, не посылает запросы. Для UTF-8 HTML/JS/CSS вычисляет SHA-256 тела после декодирования HAR; транспортное gzip/brotli в HAR уже снято, как и при сравнении с dist. При ином charset или отсутствующем теле подготовить достоверный экспорт исходных байтов; отсутствие доказательства нельзя считать совпадением.

```powershell
function Compare-SmokeWeb($Expected, $Har) {
    $ref = Get-Content -Raw -LiteralPath $Expected | ConvertFrom-Json -AsHashtable
    $log = Get-Content -Raw -LiteralPath $Har | ConvertFrom-Json
    $seen = @{}
    foreach ($entry in $log.log.entries) {
        $url = [uri]$entry.request.url
        $mime = [string]$entry.response.content.mimeType
        $path = $url.AbsolutePath
        $isAsset = $path -match '\.(js|mjs|css)$'
        $isDocument = $mime -match '^text/html' -and $path.StartsWith('/app/')
        if (-not ($isAsset -or $isDocument)) { continue }
        if ($url.GetLeftPart([System.UriPartial]::Authority) -ne $ref.origin) {
            throw 'Неожиданный origin веб-ресурса'
        }
        if ($isDocument) { $path = '/app/index.html' }
        $body = $entry.response.content
        if ($entry.response.status -ne 200 -or $null -eq $body.text -or $body.text.Length -eq 0) {
            throw "Нет полного 200-ответа с телом: $path"
        }
        if (-not $ref.files.ContainsKey($path)) { throw "Нет ресурса в эталоне: $path" }
        if ($body.encoding -eq 'base64') {
            $bytes = [Convert]::FromBase64String($body.text)
        } elseif (-not $body.encoding) {
            $bytes = [Text.Encoding]::UTF8.GetBytes([string]$body.text)
        } else { throw "Неизвестное кодирование HAR: $path" }
        $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
        if ($hash -ne $ref.files[$path]) { throw "Хеш отличается: $path" }
        $seen[$path] = $hash
    }
    foreach ($path in $ref.required) {
        if (-not $seen.ContainsKey($path)) { throw "Не загружен обязательный ресурс: $path" }
    }
    if ($seen.Count -eq 0) { throw 'Нет проверенных ресурсов' }
    [pscustomobject]@{ FrontendSHA = $ref.frontend_sha; Files = $seen; Result = 'MATCH' }
}
Compare-SmokeWeb -Expected ./expected.json -Har ./A.har
Compare-SmokeWeb -Expected ./expected.json -Har ./B.har
```

Для промежуточного HAR сохранить Preserve log с исходной загрузкой, чтобы обязательные ресурсы присутствовали. Для финиша использовать только свежую запись после reload, не весь старый Preserve log. Неполный HAR, ответ 304 без тела, недоступный эталон или невозможность закончить сверку в оставшееся время не дают Passed. Если ручной экспорт не укладывается в бюджет, подготовить более быстрый достоверный способ до следующего прогона; не вычитать сверку из длительности.

В отчёте зафиксировать отдельно старт и финиш: время с TZ, артефакт/полный SHA, результат A и B, публичные пути/хеши, источник свежей проверки backend и подтверждение оператора об отсутствии смены релиза. MATCH подтверждает соответствие файлов артефакту, а не прохождение остальных девяти пунктов smoke.
