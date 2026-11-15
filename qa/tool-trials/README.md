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
ждёт readiness, выполняет шесть прогонов и останавливает только свой процесс.
Сервер слушает 127.0.0.1: GET /health возвращает 200 и JSON status=ok,
GET / открывает тестовую HTML-страницу с кнопкой Check API; прочее — 404.

Проверки и ожидаемые exit codes:

- Bruno local: две проверки статуса/JSON успешны, exit 0.
- Bruno negative: ожидается 201 при фактическом 200, одна ошибка, exit 1.
- Playwright: страница вызывает API и показывает ok; два browser context
  изолируют localStorage. Два теста успешны, exit 0.
- Playwright negative: намеренно ожидается broken вместо ok; один тест
  падает, второй проходит, exit 1; сохраняется trace.
- k6: 1 VU, 3 секунды, sleep 0.1 между итерациями; HTTP-ошибок нет,
  все checks проходят, thresholds checks rate==1 и http_req_failed rate==0,
  exit 0. Число итераций зависит от машины.
- k6 negative: ожидается 201 вместо 200; threshold checks нарушается,
  exit 99. Одних checks без thresholds недостаточно для падения k6.

Общий runner возвращает 0, только если каждый exit code совпал с ожидаемым.
Он специально проверяет намеренные падения; этот запуск не заменяет обычную
API/e2e-регрессию, где любая неожиданная ошибка должна давать красный CI.

## Артефакты

В reports сохраняются:

- trial-summary.json — версии, команды, окружения и коды шести запусков;
- bruno-pass/negative.json и .xml — JSON/JUnit Bruno;
- playwright-pass/negative.xml — JUnit Playwright;
- playwright-negative-artifacts — ошибка и trace.zip;
- k6-pass/negative.json — метрики и результаты thresholds;
- *.log — вывод отдельных инструментов.

reports и .tools исключены из Git. Исходники, lock-файл и итог в tools.md
сохраняются. Для просмотра отрицательного trace:

```bash
npx --no-install playwright show-trace reports/playwright-negative-artifacts/fixture-local-page-fetches-and-displays-the-API-response/trace.zip
```

## Отдельные запуски

Для Bruno/k6 сначала запустите npm run trial:server в первом терминале.
Во втором доступны npm run trial:bruno, npm run trial:bruno:negative,
npm run trial:k6 и npm run trial:k6:negative.
Playwright самостоятельно поднимает сервер командой npm run trial:playwright;
для него порт должен быть свободен. Папка reports создаётся общим runner;
при полностью отдельном запуске Bruno сначала выполните mkdir -p reports.

## Известные ограничения

npm audit после установки сообщает 18 advisories: 8 high и 10 moderate,
связанных с зависимостями Bruno. Это не исправлено и не подтверждено как
эксплуатируемое в данном fixture. Автоматический force-fix не выполнялся:
предлагаемый для части проблем переход меняет major-версию CLI на 3.4.2.
Перед запуском на внешних API и включением в CI необходим разбор этих advisories.
Для повторной проверки: npm audit --json. При проверке 15 ноября отчёт
сохранён локально в reports/npm-audit.json.

Результаты: [tools.md](../../docs/qa/tools.md).
