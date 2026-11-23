# T49: зависимости Bruno для API-коллекции

Дата проверки: 19 ноября 2026. Область: только `docs/qa/api-tests/package-lock.json`, Node.js 24.16.0/npm 11.13.0, Bruno CLI 4.3.0. Исходный [разбор T24](../t24-dependency-review.md) остаётся историческим отчётом другого lock-файла; его 18 уязвимых пакетов здесь не игнорируются.

## Решение

В новом профиле используется точный lock и npm overrides для исправленных зависимостей. `npm ci --ignore-scripts` и `npm audit --audit-level=moderate` обязательны перед запуском, включая сборку образа и CI. На дату проверки audit этого профиля сообщает **0 vulnerabilities**, включая high/moderate. Это проверка базы advisories для установленного дерева, а не доказательство отсутствия неизвестных уязвимостей.

Обновлены все разрешённые копии следующих пакетов:

- axios **1.20.0** и form-data **4.0.6**: пути от CLI напрямую и через `@usebruno/requests`, а также унаследованный риск gaxios через его axios. Проверяются реальные HTTP-запросы Bruno, авторизация, обработка ошибочных ответов, HTTPS и cookies; form-data — создание корректного multipart в compatibility check. Multipart endpoint в T49 отсутствует.
- `@faker-js/faker` **10.5.0**: `CLI → @usebruno/requests → Faker`. Проверяется загрузка из CommonJS на Node 24 и обычный `helpers.fake` с генерацией UUID. Недоверенные шаблоны не используются.
- js-yaml **4.3.2**: CLI/converters; yaml **2.9.1**: filestore/js и прямой парсер OpenAPI. Проверяется обычный разбор обоими парсерами и реальная компиляция обоих контрактов через yaml/Ajv.
- csv-parse **7.0.2**: CLI. Проверяется синхронный API и настоящий CLI-прогон с однострочным `compatibility.csv`; первый запрос обязательно проверяет полученное значение итерации.
- glob **14.0.2** и minimatch **11.0.1**: `requests → secret-manager → google-gax → rimraf → glob → minimatch`. Проверяются используемые API globSync/minimatch на файлах коллекции. Удаление временных файлов runner выполняет штатным fs, а Google Secret Manager не используется.
- uuid **11.1.1**: js/requests и их зависимости. Проверяются CommonJS загрузка, v4 и validate.

Пути и конкретные GHSA исходного уязвимого дерева перечислены в разборе T24. Для текущего дерева повторить:

```sh
npm --prefix docs/qa/api-tests ci --ignore-scripts
npm --prefix docs/qa/api-tests audit --json
npm --prefix docs/qa/api-tests explain axios form-data @faker-js/faker js-yaml yaml csv-parse glob minimatch uuid --json
npm --prefix docs/qa/api-tests run check
npm --prefix docs/qa/api-tests run compose
npm --prefix docs/qa/api-tests run check:reports
```

## Совместимость и пределы решения

Major-переходы Faker/csv-parse/glob/minimatch/uuid проверяются на закреплённом Node 24.16.0. Позитивный Compose-прогон, единственное ожидаемое падение схемы, cookie-ротация, последовательные переменные, CSV и JSON/JUnit подтверждают совместимость **используемой HTTP-коллекции**. Из этого не следует проверка всех функций Bruno: gRPC-генерация Faker, Google/GCP-auth/Secret Manager, импорт произвольных коллекций и multipart загрузки в сервис не входят в область T49. Для их добавления нужны отдельные проверки совместимости; текущая коллекция не вызывает эти пути.

План сопровождения: при обновлении Bruno проверить возможность удаления overrides, выполнить clean npm ci, audit и оба полных прогона. Новый advisory уровня moderate и выше блокирует этот job до исправления или отдельного обоснованного решения команды. Не применять `npm audit fix --force` автоматически. Старый T24-профиль сохраняет ранее описанные ограничения; этот профиль не следует использовать для внешнего API, потому что fixture/fault injection рассчитаны исключительно на приватный Compose-стенд.

Механизм overrides: [npm package.json](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#overrides). CLI-флаги: [Bruno run options](https://docs.usebruno.com/bru-cli/run/options). Здесь используется закреплённый CLI 4.3.0 с `--experimental-cache-modules`; не подменять его флагом от другой версии без повторного прогона.
