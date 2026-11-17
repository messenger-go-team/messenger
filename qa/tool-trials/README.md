# T24: пробные запуски инструментов

Набор проверяет установку и запуск Bruno CLI, Playwright и k6 на локальной заглушке.
Он не проверяет бизнес-функции Messenger, контракты целиком или нагрузочные NFR.

Проверенные версии: Node.js 24.16.0, npm 11.13.0, Bruno CLI 4.3.0,
Playwright 1.65.1 (Chromium 159.0.8154.6), k6 2.4.0 (Windows amd64).
Зависимости npm закреплены в package.json/package-lock.json, k6 — в setup-k6.cjs.

## Подготовка Windows

В Git Bash из корня репозитория:

```bash
cd qa/tool-trials
npm ci
npx --no-install playwright install chromium
node setup-k6.cjs
```

setup-k6.cjs скачивает официальный ZIP k6 v2.4.0 и сверяет SHA256 с digest
архива из [официального релиза](https://github.com/grafana/k6/releases/tag/v2.4.0).
Файлы помещаются только в .tools; системный PATH не меняется. При несовпадении
хеша скрипт завершается с ошибкой. Установщик использует Node.js и встроенный в Windows tar.exe; изменения
ExecutionPolicy не требуются. Можно использовать установленный k6 2.4.0,
задав K6_BIN полным путём к бинарнику.
Для Linux/macOS установите k6 2.4.0 по официальной инструкции; runner использует PATH.
Проверен именно Windows; перенос на CI/Linux требует отдельного прогона.

## Полный локальный прогон

```bash
npm run trial:all
```

Порт 3100 должен быть свободен. Если ранее запускали node server.cjs вручную,
остановите его Ctrl+C. Runner проверяет порт, запускает собственную заглушку,
ждёт readiness, выполняет семь прогонов и останавливает только свой процесс.
Сервер слушает 127.0.0.1: GET /health возвращает 200 и JSON status=ok,
GET / открывает страницу с кнопкой Check API. Auth-маршруты обслуживают
контрактный PoC; прочее — 404. Заглушка не является реализацией Messenger.

Проверки и ожидаемые exit codes:

- Bruno local: две проверки статуса/JSON успешны, exit 0.
- Bruno negative: ожидается 201 при фактическом 200, одна ошибка, exit 1.
- Bruno PoC: 7 запросов, 20 проверок текущих схем auth.yaml, bearer и cookie jar,
  exit 0. Запускается в Developer Mode для внешнего Ajv и чтения YAML; только
  доверенные локальные файлы. Базовая health-коллекция использует Safe Mode.
- Playwright: страница вызывает API и показывает ok; два browser context
  изолируют localStorage. Два теста успешны, exit 0.
- Playwright negative: намеренно ожидается broken вместо ok; один тест
  падает, второй проходит, exit 1; сохраняется trace.
- k6: 1 VU, 3 секунды, sleep 0.1 между итерациями; HTTP-ошибок нет,
  все checks проходят, thresholds checks rate==1 и http_req_failed rate==0,
  exit 0. Число итераций зависит от машины.
- k6 negative: ожидается 201 вместо 200; threshold checks нарушается,
  exit 99. Одних checks без thresholds недостаточно для падения k6.

Общий runner возвращает 0, только если коды и содержимое свежих JSON/JUnit
соответствуют ожиданиям. Для Bruno проверяются имена всех тестов, ровно одна
ошибка expected 200 to equal 201 и успех второй проверки. Для Playwright —
конкретное ожидание broken вместо ok и успех теста изоляции, отсутствие
ошибок загрузки, пропусков и повторов. Старые отчёты удаляются до запуска.
У k6 проверяются URL, оба checks, отсутствие HTTP-ошибок и thresholds.

trial:all принудительно передаёт BASE_URL=http://127.0.0.1:3100. run-k6.cjs
закрепляет тот же URL и отключает proxy; health.js отвергает другой адрес
и запрещает редиректы. Перед нагрузкой проверяется версия k6 строго 2.4.0,
включая бинарник из PATH или K6_BIN на Linux/macOS. Сами Linux/macOS не проверялись.
Он специально проверяет намеренные падения; этот запуск не заменяет обычную
API/e2e-регрессию, где любая неожиданная ошибка должна давать красный CI.

## Проверка исправлений ревью

```bash
npm run trial:verify
```

Или npm test. Проверка поднимает отдельный контрольный сервис, наследует
его адрес в BASE_URL и выполняет trial:all. Успех требует нуля обращений
к контрольному сервису и семи подтверждённых отчётов. Далее семь тестов
валидаторов проверяют ошибки запуска/загрузки, посторонние падения,
отсутствующий отчёт, неверный адрес, перенос credentials и другую версию k6.

Для ручной проверки внешней переменной в Git Bash:

```bash
BASE_URL=https://staging.invalid npm run trial:all
```

Внешний адрес не должен использоваться; в k6-отчётах trial.base_url должен
оставаться http://127.0.0.1:3100.

## Контрактный PoC

bruno-poc/contract.cjs читает api/openapi/auth.yaml из текущего checkout,
валидирует Ajv2020 8.20.0 + ajv-formats 3.0.1; yaml 2.9.1 читает контракт.
Цепочка: login → профиль → невалидный профиль → контакты → refresh → logout
→ refresh после logout (401). Проверяются корневые/вложенные $ref, response $ref,
форматы uuid/date-time, required/type/additionalProperties/const. Cookie jar
автоматически сохраняет, отправляет, ротирует и удаляет refresh cookie.

У fixture нет HTTPS: Secure опущен намеренно, access-токены фиктивные.
JWT-подпись и реальный сервис не проверяются. Полная коллекция auth/history,
HTTPS/Secure и остальные конструкции OpenAPI остаются в T49. Входные
credentials фиктивные; перед настоящими токенами нужно проверить содержимое
всех отчётов: Bruno маскирует исходящие заголовки, но тело ответа может
содержать access_token. Developer Mode не является защитной границей.

## Артефакты

В reports сохраняются:

- trial-summary.json — версии, команды, окружения и коды семи запусков;
- bruno-pass/negative.json и .xml, bruno-poc.json/xml — JSON/JUnit Bruno;
- playwright-pass/negative.json и .xml — JSON/JUnit Playwright;
- playwright-negative-artifacts — ошибка и trace.zip;
- k6-pass/negative.json — метрики и результаты thresholds;
- base-url-regression.json — адрес контрольного сервиса и ноль запросов;
- *.log — вывод отдельных инструментов.

reports и .tools исключены из Git. Исходники, lock-файл и итог в tools.md
сохраняются. Для просмотра отрицательного trace:

```bash
npx --no-install playwright show-trace reports/playwright-negative-artifacts/fixture-local-page-fetches-and-displays-the-API-response/trace.zip
```

## Отдельные запуски

Для Bruno/k6 сначала запустите npm run trial:server в первом терминале.
Во втором доступны npm run trial:bruno, npm run trial:bruno:negative,
npm run trial:k6, npm run trial:k6:negative и npm run trial:bruno:poc.
Playwright самостоятельно поднимает сервер командой npm run trial:playwright;
для него порт должен быть свободен. Папка reports создаётся общим runner;
при полностью отдельном запуске Bruno сначала выполните mkdir -p reports.

## Известные ограничения

npm audit сообщает 18 записей уязвимых пакетов: 8 high и 10 moderate
(20 уникальных GHSA с учётом транзитивного риска). Они не исправлены.
[Разбор зависимостей](../../docs/qa/t24-dependency-review.md) содержит все пути,
advisories, условия применимости и план. Внешние API и CI отложены до
устранения high и решения команды по оставшимся moderate. Force-fix не применялся.
Повторная проверка: npm audit --json; отчёт сохранён в reports/npm-audit.json.

Результаты: [tools.md](../../docs/qa/tools.md).
