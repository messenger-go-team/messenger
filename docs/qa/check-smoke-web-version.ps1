param([string]$Document = (Join-Path $PSScriptRoot 'smoke-web-version.md'))
$ErrorActionPreference = 'Stop'
$markdown = Get-Content -Raw -LiteralPath $Document
$block = [regex]::Match($markdown, '(?s)```powershell\s*\r?\n(.*?)\r?\n```')
if (-not $block.Success) { throw 'PowerShell function block not found' }
$source = $block.Groups[1].Value
$call = $source.IndexOf('Compare-SmokeWeb -Expected')
if ($call -lt 0) { throw 'Documented invocation not found' }
. ([scriptblock]::Create($source.Substring(0, $call)))

$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\', '/')
$work = Join-Path $tempRoot ('messenger-smoke-har-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
    function Get-Hash([string]$Text) {
        [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Text))).ToLowerInvariant()
    }
    function New-Entry($Path, $Mime, $Text, $Type) {
        @{
            _resourceType = $Type
            request = @{ url = "https://staging.tidingm.ru$Path"; headers = @() }
            response = @{ status = 200; content = @{ mimeType = $Mime; text = $Text } }
        }
    }
    $html = '<html>Контрольная версия</html>'
    $js = 'console.log("smoke");'
    $css = 'body { color: black; }'
    $expected = @{
        frontend_sha = 'c43261670105960eb4eb6b14a3a59427e07b195f'
        origin = 'https://staging.tidingm.ru'
        files = @{
            '/app/index.html' = Get-Hash $html
            '/app/assets/main.js' = Get-Hash $js
            '/app/assets/main.css' = Get-Hash $css
        }
        required = @('/app/index.html', '/app/assets/main.js', '/app/assets/main.css')
    }
    $baseline = @{ log = @{ entries = @(
        (New-Entry '/app/login' 'text/html' $html 'document'),
        (New-Entry '/app/assets/main.js' 'application/javascript' $js 'script'),
        (New-Entry '/app/assets/main.css' 'text/css' $css 'stylesheet')
    ) } }
    $expectedPath = Join-Path $work 'expected.json'
    $harPath = Join-Path $work 'candidate.har'
    $expected | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $expectedPath -Encoding utf8
    function Copy-Har { $baseline | ConvertTo-Json -Depth 20 | ConvertFrom-Json -AsHashtable }
    function Run-Har($Har) {
        $Har | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $harPath -Encoding utf8
        Compare-SmokeWeb -Expected $expectedPath -Har $harPath
    }
    $positive = @(
        @{ name = 'UTF-8 HTML/JS/CSS'; change = { param($h) } },
        @{ name = 'base64 JS'; change = { param($h) $h.log.entries[1].response.content.encoding = 'base64'; $h.log.entries[1].response.content.text = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($js)) } },
        @{ name = 'Sec-Fetch-Dest document'; change = { param($h) $h.log.entries[0].Remove('_resourceType'); $h.log.entries[0].request.headers = @(@{ name = 'Sec-Fetch-Dest'; value = 'document' }) } },
        @{ name = 'MIME case and charset'; change = { param($h) $h.log.entries[0].response.content.mimeType = 'Text/HTML; charset=UTF-8'; $h.log.entries[1].response.content.mimeType = 'text/javascript; charset=utf-8' } }
    )
    foreach ($test in $positive) {
        $har = Copy-Har
        $null = & $test.change $har
        $result = Run-Har $har
        if ($result.Result -ne 'MATCH' -or $result.Files.Count -ne 3) { throw "Unexpected positive result: $($test.name)" }
        Write-Output "PASS positive: $($test.name)"
    }
    # Add malformed responses to an otherwise complete HAR: required files alone
    # must not hide a failing lazy request behind the valid index.html hash.
    $negative = @(
        @{ name = 'review: unknown JS returns SPA HTML'; error = 'HTML вместо JS/CSS'; change = { param($h) $h.log.entries += New-Entry '/app/assets/unknown-lazy.js' 'text/html' $html 'script' } },
        @{ name = 'known JS returns SPA HTML'; error = 'HTML вместо JS/CSS'; change = { param($h) $h.log.entries += New-Entry '/app/assets/main.js' 'text/html' $html 'script' } },
        @{ name = 'unknown CSS returns SPA HTML'; error = 'HTML вместо JS/CSS'; change = { param($h) $h.log.entries += New-Entry '/app/assets/unknown.css' 'text/html' $html 'stylesheet' } },
        @{ name = 'known CSS returns SPA HTML'; error = 'HTML вместо JS/CSS'; change = { param($h) $h.log.entries += New-Entry '/app/assets/main.css' 'text/html' $html 'stylesheet' } },
        @{ name = 'JS URL marked document'; error = 'HTML вместо JS/CSS'; change = { param($h) $h.log.entries += New-Entry '/app/assets/unknown-lazy.js' 'text/html' $html 'document' } },
        @{ name = 'extensionless script returns HTML'; error = 'HTML вместо JS/CSS'; change = { param($h) $h.log.entries += New-Entry '/app/lazy' 'text/html' $html 'script' } },
        @{ name = 'unknown HTML response without document identity'; error = 'HTML-ответ без признака документа'; change = { param($h) $h.log.entries += New-Entry '/app/unrelated' 'text/html' $html 'fetch' } },
        @{ name = 'invalid script MIME'; error = 'Неверный MIME JS/CSS'; change = { param($h) $h.log.entries[1].response.content.mimeType = 'application/json' } },
        @{ name = 'changed hash'; error = 'Хеш отличается'; change = { param($h) $h.log.entries[1].response.content.text = 'changed' } },
        @{ name = 'missing response body'; error = 'Нет полного 200-ответа'; change = { param($h) $h.log.entries[1].response.content.Remove('text') } },
        @{ name = '304 without full response'; error = 'Нет полного 200-ответа'; change = { param($h) $h.log.entries[1].response.status = 304 } },
        @{ name = 'missing required JS'; error = 'Не загружен обязательный ресурс'; change = { param($h) $h.log.entries = @($h.log.entries[0], $h.log.entries[2]) } },
        @{ name = 'unknown JS with valid MIME'; error = 'Нет ресурса в эталоне'; change = { param($h) $h.log.entries += New-Entry '/app/assets/unknown.js' 'application/javascript' $js 'script' } },
        @{ name = 'foreign origin'; error = 'Неожиданный origin'; change = { param($h) $h.log.entries[1].request.url = 'https://other.example/main.js' } },
        @{ name = 'empty HAR'; error = 'Не загружен обязательный ресурс'; change = { param($h) $h.log.entries = @() } }
    )
    foreach ($test in $negative) {
        $har = Copy-Har
        $null = & $test.change $har
        $caught = $false
        try { $null = Run-Har $har }
        catch {
            if (-not $_.Exception.Message.Contains($test.error)) { throw }
            $caught = $true
        }
        if (-not $caught) { throw "False MATCH: $($test.name)" }
        Write-Output "PASS negative: $($test.name)"
    }
    Write-Output "Verified documented function: $($positive.Count) positive, $($negative.Count) negative controls"
} finally {
    $resolved = [IO.Path]::GetFullPath($work)
    if ([IO.Path]::GetDirectoryName($resolved) -ne $tempRoot -or -not [IO.Path]::GetFileName($resolved).StartsWith('messenger-smoke-har-')) {
        throw 'Unexpected temporary directory; cleanup refused'
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
