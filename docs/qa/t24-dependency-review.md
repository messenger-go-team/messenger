# T24: разбор зависимостей Bruno

Дата: 16 ноября 2026. Область: qa/tool-trials/package-lock.json; Node.js 24.16.0, npm 11.13.0, Bruno CLI 4.3.0. Это оценка по lock-файлу и advisories, не эксплуатационный пентест.

## Результат и решение

Повторный npm audit: **18 записей уязвимых пакетов: 8 high, 10 moderate, 0 critical**. Это включает наследуемый риск пакетов-обёрток, а не количество advisories. Ниже перечислены все **20 уникальных GHSA** и пути всех 18 записей. Для прямых Ajv 8.20.0, ajv-formats 3.0.1, yaml 2.9.1 и fast-xml-parser 5.12.1 записей в этом отчёте нет; это не гарантия отсутствия неизвестных дефектов.

Bruno функционально пригоден для T49 по результатам PoC. **Подключение внешних API и CI отложено до устранения high и решения по оставшимся moderate.** Локальная проба выполняется на доверенной заглушке без настоящих credentials. Уязвимости этим PR не исправлены, остаточный риск за команду не принят.

Источники: npm audit --json, npm explain … --json и первичные GitHub Security Advisories. Полные ответы сохранены локально в reports/npm-audit.json, npm-explain.json и advisory-details.json. Отчёты исключены из Git; вывод и план зафиксированы здесь.

## Пути зависимостей и применимость

Для каждой записи указан кратчайший подтверждённый npm explain путь от qa/tool-trials. Дополнительные пути возможны; установленные копии перечислены отдельно. Severity пакета-обёртки не означает наличие собственной GHSA.

### @faker-js/faker — high

- `@usebruno/cli@4.3.0 → @usebruno/requests@0.22.0 → @faker-js/faker@9.9.0` (`node_modules/@faker-js/faker`).

Применимость: helpers.fake с недоверенным шаблоном может выполнить код. В fixture шаблоны Faker не используются; до импорта сторонних коллекций требуется исправление. Developer Mode не является защитной границей.

- [GHSA-qxc2-j82w-r537](https://github.com/advisories/GHSA-qxc2-j82w-r537): Faker: helpers.fake exploitable into arbritary code execution. Диапазон текущей ветки: `<=10.4.0`; исправленные версии в advisory: `10.5.0`.

### @usebruno/cli — high

- `@usebruno/cli@4.3.0` (`node_modules/@usebruno/cli`).

Наследует риск через `@usebruno/converters`, `@usebruno/filestore`, `@usebruno/js`, `@usebruno/requests`, `axios`, `csv-parse`, `form-data`, `js-yaml`. Применимость и исправление — по конечным пакетам; собственной GHSA в отчёте нет.

### @usebruno/converters — high

- `@usebruno/cli@4.3.0 → @usebruno/converters@0.25.0` (`node_modules/@usebruno/converters`).

Наследует риск через `js-yaml`. Применимость и исправление — по конечным пакетам; собственной GHSA в отчёте нет.

### @usebruno/filestore — moderate

- `@usebruno/cli@4.3.0 → @usebruno/filestore@0.14.0` (`node_modules/@usebruno/filestore`).

Наследует риск через `yaml`. Применимость и исправление — по конечным пакетам; собственной GHSA в отчёте нет.

### @usebruno/js — high

- `@usebruno/cli@4.3.0 → @usebruno/js@0.55.0` (`node_modules/@usebruno/js`).

Наследует риск через `@usebruno/requests`, `axios`, `uuid`, `yaml`. Применимость и исправление — по конечным пакетам; собственной GHSA в отчёте нет.

### @usebruno/requests — high

- `@usebruno/cli@4.3.0 → @usebruno/requests@0.22.0` (`node_modules/@usebruno/requests`).

Наследует риск через `@faker-js/faker`, `axios`. Применимость и исправление — по конечным пакетам; собственной GHSA в отчёте нет.

### axios — high

- `@usebruno/cli@4.3.0 → axios@1.18.0` (`node_modules/axios`).

Применимость: HTTP-клиент Bruno используется в T24. Методы и HTTP/1.1 URL заданы явно; заглушка не перенаправляет запросы. Для внешних API риски ниже реалистичны. Все внутренние адаптеры Bruno отдельно не аттестованы.

- [GHSA-vh66-26gq-q6x8](https://github.com/advisories/GHSA-vh66-26gq-q6x8): Axios: Prototype pollution gadget in fetch adapter can alter outbound requests. Диапазон текущей ветки: `>=1.7.0 <1.20.0`; исправленные версии в advisory: `1.20.0`.
- [GHSA-9fr6-4gfg-395g](https://github.com/advisories/GHSA-9fr6-4gfg-395g): Axios: Prototype-Pollution Gadget in the Default Instance Allows Inherited Object.prototype.method to Override HTTP Method. Диапазон текущей ветки: `>=1.0.0 <1.20.0`; исправленные версии в advisory: `0.34.0`, `1.20.0`.
- [GHSA-c29m-xwm3-cm6r](https://github.com/advisories/GHSA-c29m-xwm3-cm6r): Axios: ReDoS in fromDataURI data: URL parser freezes the Node event loop (DoS). Диапазон текущей ветки: `>=1.16.1 <1.20.0`; исправленные версии в advisory: `1.20.0`.
- [GHSA-mghh-pgcx-3jjj](https://github.com/advisories/GHSA-mghh-pgcx-3jjj): Axios: ReDoS (O(NВІ)) in shouldBypassProxy host normalization, reachable via untrusted redirect Location. Диапазон текущей ветки: `>=1.15.0 <1.20.0`; исправленные версии в advisory: `1.20.0`.
- [GHSA-x97p-jq2g-jp4f](https://github.com/advisories/GHSA-x97p-jq2g-jp4f): Axios: Prototype Pollution Gadget in axios toFormData Options. Диапазон текущей ветки: `>=1.15.1 <1.20.0`; исправленные версии в advisory: `0.34.0`, `1.20.0`.
- [GHSA-3pq3-5fj3-cg6v](https://github.com/advisories/GHSA-3pq3-5fj3-cg6v): Axios: HTTP/2 adapter bypasses configured DNS lookup and proxy controls. Диапазон текущей ветки: `>=1.13.0 <1.20.0`; исправленные версии в advisory: `1.20.0`.
- [GHSA-542g-h47m-68v8](https://github.com/advisories/GHSA-542g-h47m-68v8): Axios: Denial of Service via Unhandled 'error' Event in HTTP/2 ClientHttp2Session Initialization. Диапазон текущей ветки: `>=1.13.0 <1.20.0`; исправленные версии в advisory: `1.20.0`.
- [GHSA-j8rh-479h-cp32](https://github.com/advisories/GHSA-j8rh-479h-cp32): Axios: Header Injection via Inherited headers After Minimal Interceptor. Диапазон текущей ветки: `>=1.0.0 <1.20.0`; исправленные версии в advisory: `1.20.0`.
- [GHSA-4hqw-qxg8-jxx2](https://github.com/advisories/GHSA-4hqw-qxg8-jxx2): Axios: Fetch Adapter Header Injection via Inherited FormData getHeaders. Диапазон текущей ветки: `>=1.12.0 <1.20.0`; исправленные версии в advisory: `1.20.0`.
- [GHSA-m8m8-qj5v-23w3](https://github.com/advisories/GHSA-m8m8-qj5v-23w3): Axios: Node HTTP adapter prototype-pollution gadget allows request socket hijack via inherited createConnection. Диапазон текущей ветки: `>=1.15.2 <1.20.0`; исправленные версии в advisory: `1.20.0`.
- [GHSA-44g4-m2mj-wpvx](https://github.com/advisories/GHSA-44g4-m2mj-wpvx): Axios: CIDR-form NO_PROXY entries are ignored, causing proxy exclusion bypass for internal IP ranges. Диапазон текущей ветки: `>=1.15.0 <1.20.0`; исправленные версии в advisory: `1.20.0`.
- [GHSA-r4gj-5m52-g5wh](https://github.com/advisories/GHSA-r4gj-5m52-g5wh): Axios: maxRedirects: 0 is not enforced by the fetch adapter, allowing redirect-based SSRF. Диапазон текущей ветки: `>=1.17.0 <1.20.0`; исправленные версии в advisory: `1.20.0`.

### csv-parse — moderate

- `@usebruno/cli@4.3.0 → csv-parse@5.6.0` (`node_modules/csv-parse`).

Применимость: Замена прототипа записи через дублирующий __proto__ при columns=true и group_columns_by_name=true. CSV в T24 не читается. Для T49 с внешним CSV не включать сочетание этих опций до обновления.

- [GHSA-8cw4-87c7-c6xx](https://github.com/advisories/GHSA-8cw4-87c7-c6xx): node-csv: Prototype replacement still reachable via columns path. Диапазон текущей ветки: `<7.0.2`; исправленные версии в advisory: `7.0.2`.

### form-data — high

- `@usebruno/cli@4.3.0 → form-data@4.0.4` (`node_modules/form-data`).

Применимость: CRLF-инъекция при недоверенных именах полей/файлов multipart. Здесь используется JSON без multipart. Перед тестами файлов обновить зависимость.

- [GHSA-hmw2-7cc7-3qxx](https://github.com/advisories/GHSA-hmw2-7cc7-3qxx): form-data: CRLF injection in form-data via unescaped multipart field names and filenames. Диапазон текущей ветки: `>=4.0.0 <4.0.6`; исправленные версии в advisory: `2.5.6`, `3.0.5`, `4.0.6`.

### gaxios — moderate

- `@usebruno/cli@4.3.0 → @usebruno/requests@0.22.0 → google-auth-library@10.5.0 → gcp-metadata@8.1.4 → gaxios@7.1.3` (`node_modules/gcp-metadata/node_modules/gaxios`).

Наследует риск через `rimraf`. Применимость и исправление — по конечным пакетам; собственной GHSA в отчёте нет.

### gcp-metadata — moderate

- `@usebruno/cli@4.3.0 → @usebruno/requests@0.22.0 → google-auth-library@10.5.0 → gcp-metadata@8.1.4` (`node_modules/gcp-metadata`).

Наследует риск через `gaxios`. Применимость и исправление — по конечным пакетам; собственной GHSA в отчёте нет.

### glob — moderate

- `@usebruno/cli@4.3.0 → @usebruno/requests@0.22.0 → @google-cloud/secret-manager@6.3.0 → google-gax@5.0.8 → rimraf@5.0.10 → glob@10.5.0` (`node_modules/glob`).

Применимость: Обход файлов продолжается после AbortSignal. Доверенная небольшая коллекция ограничивает риск; большое недоверенное дерево может вызвать DoS. Фактическое использование отмены в Bruno не доказано.

- [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4): Glob: AbortSignal cancellation bypass allows post-timeout filesystem traversal. Диапазон текущей ветки: `>=9.0.0 <=14.0.1`; исправленные версии в advisory: `14.0.2`.

### google-gax — moderate

- `@usebruno/cli@4.3.0 → @usebruno/requests@0.22.0 → @google-cloud/secret-manager@6.3.0 → google-gax@5.0.8` (`node_modules/google-gax`).

Наследует риск через `rimraf`. Применимость и исправление — по конечным пакетам; собственной GHSA в отчёте нет.

### js-yaml — high

- `@usebruno/cli@4.3.0 → js-yaml@4.3.1` (`node_modules/js-yaml`).

Применимость: DoS на YAML merge с множеством пустых источников. CLI/converters содержат уязвимый парсер. PoC читает проверенный auth.yaml через yaml 2.9.1; это не исправляет js-yaml в Bruno.

- [GHSA-2883-xcg3-v3hh](https://github.com/advisories/GHSA-2883-xcg3-v3hh): js-yaml: maxTotalMergeKeys does not limit CPU use for empty merge sources. Диапазон текущей ветки: `>=4.0.0 <4.3.2`; исправленные версии в advisory: `3.15.2`, `4.3.2`.

### minimatch — moderate

- `@usebruno/cli@4.3.0 → @usebruno/requests@0.22.0 → @google-cloud/secret-manager@6.3.0 → google-gax@5.0.8 → rimraf@5.0.10 → glob@10.5.0 → minimatch@9.0.9` (`node_modules/minimatch`).

Применимость: DoS при недоверенном glob-шаблоне и optimizationLevel>=2. В T24 шаблоны контролируются репозиторием; достижимость режима внутри Bruno не доказана.

- [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249): minimatch has potential denial of service via globparts amplification. Диапазон текущей ветки: `>=7.0.0 <11.0.1`; исправленные версии в advisory: `11.0.1`.

### rimraf — moderate

- `@usebruno/cli@4.3.0 → @usebruno/requests@0.22.0 → @google-cloud/secret-manager@6.3.0 → google-gax@5.0.8 → rimraf@5.0.10` (`node_modules/rimraf`).

Наследует риск через `glob`. Применимость и исправление — по конечным пакетам; собственной GHSA в отчёте нет.

### uuid — moderate

- `@usebruno/cli@4.3.0 → @usebruno/js@0.55.0 → uuid@10.0.0` (`node_modules/uuid`).

Применимость: Неполные записи во внешний короткий буфер/offset в v3/v5/v6. Fixture использует node:crypto.randomUUID без такого API. Внутренние вызовы Bruno полностью не исследованы; major-обновление требует проверки CommonJS.

- [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq): uuid: Missing buffer bounds check in v3/v5/v6 when buf is provided. Диапазон текущей ветки: `<11.1.1`; исправленные версии в advisory: `11.1.1`, `12.0.1`, `13.0.1`.

### yaml — moderate

- `@usebruno/cli@4.3.0 → @usebruno/filestore@0.14.0 → yaml@2.3.4` (`node_modules/@usebruno/filestore/node_modules/yaml`).
- `@usebruno/cli@4.3.0 → @usebruno/js@0.55.0 → yaml@2.3.4` (`node_modules/@usebruno/js/node_modules/yaml`).

Применимость: Глубоко вложенный YAML вызывает stack overflow. В Bruno остаются две копии 2.3.4; прямой yaml 2.9.1 их не заменяет. В T24 используются проверенные документы; обе копии нужно обновить.

- [GHSA-48c2-rrv3-qjmp](https://github.com/advisories/GHSA-48c2-rrv3-qjmp): yaml is vulnerable to Stack Overflow via deeply nested YAML collections. Диапазон текущей ветки: `>=2.0.0 <2.8.3`; исправленные версии в advisory: `1.10.3`, `2.8.3`.

## Условия для Axios

- GHSA-vh66-26gq-q6x8, GHSA-9fr6-4gfg-395g, GHSA-x97p-jq2g-jp4f, GHSA-j8rh-479h-cp32, GHSA-4hqw-qxg8-jxx2, GHSA-m8m8-qj5v-23w3: требуют предварительного prototype pollution в том же процессе и соответствующего адаптера/сериализации. Источник pollution в T24 не установлен; это условная оценка, не доказательство недостижимости.
- GHSA-c29m-xwm3-cm6r: ReDoS при недоверенном data: URL; в T24 URL фиксирован и использует HTTP.
- GHSA-mghh-pgcx-3jjj: crafted redirect Location с proxy/NO_PROXY вызывает ReDoS. Заглушка не выдаёт редиректы; для внешних API условие реалистично.
- GHSA-3pq3-5fj3-cg6v и GHSA-542g-h47m-68v8: требуют HTTP/2 и могут дать обход DNS/proxy-контроля или падение процесса. T24 не включает HTTP/2.
- GHSA-44g4-m2mj-wpvx: CIDR в NO_PROXY игнорируется; внешний API может пойти через proxy вопреки ожиданиям. Нельзя полагаться на этот список как защиту. Fixture использует loopback без CIDR.
- GHSA-r4gj-5m52-g5wh: fetch-адаптер игнорирует maxRedirects:0; нужна проверка адаптера и редиректов внешнего API. Запрет редиректов k6 не затронут: там другой HTTP-движок.

## План устранения и критерий снятия ограничения

Предлагаемые роли: автор QA-набора готовит обновление и повторные прогоны; reviewer/backend-владелец подтверждает совместимость и остаточный риск до T49/CI. Люди ещё не назначены, принятие риска не выполнено.

1. Подобрать релиз Bruno с Axios >=1.20.0, form-data >=4.0.6, Faker >=10.5.0, js-yaml >=4.3.2, yaml >=2.8.3. Проверять реально разрешённые копии через npm explain и audit, а не только верхнюю версию CLI.
2. Для moderate обновить csv-parse >=7.0.2, glob >=14.0.2, minimatch >=11.0.1 и uuid с исправлением (ветка 11: >=11.1.1; для 12/13 см. GHSA). Major-переходы требуют проверки API, Node и CommonJS-совместимости Bruno; слепые overrides не применять.
3. Если готового релиза нет, подготовить upstream fix или ограниченный override после анализа совместимости. npm audit fix --force предлагает CLI 3.4.2: этот откат не считать проверенным исправлением без повторной оценки дерева и функционального PoC.
4. После обновления выполнить npm ci, npm audit --json, npm explain для оставшихся копий и npm run trial:verify. Повторить PoC схем, bearer и cookie jar; проверить редиректы и применимые негативные примеры на контролируемом сервере. Exploit в этом PR не запускался.
5. До внешних API/CI: устранить high; каждый оставшийся moderate устранить либо согласовать с командой условия, ответственного и срок пересмотра. Ограничение снимается после ревью обновлённого audit и повторных прогонов. Этот документ не принимает остаточный риск.

## Повторение анализа

Из qa/tool-trials: npm audit --json и npm explain axios form-data @faker-js/faker csv-parse glob js-yaml minimatch uuid yaml --json. Ненулевой код npm audit ожидаем для текущего lock-файла; создание отчёта не является успешным security check.
