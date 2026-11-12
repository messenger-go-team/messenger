# Команда и ревью

| GitHub | Роль в команде | Доступ к репозиторию |
| --- | --- | --- |
| [afilistovich](https://github.com/afilistovich) | Бэкенд, владелец проекта | Admin |
| [kakocuk1](https://github.com/kakocuk1) | Бэкенд | Admin |
| [RepinDM](https://github.com/RepinDM) | Фронтенд | Write |
| [make-smart-products](https://github.com/make-smart-products) | QA | Write |
| [zavdaria](https://github.com/zavdaria) | Дизайнер | Write |

Права GitHub назначаются в настройках репозитория. Изменение этой таблицы
или CODEOWNERS само по себе не выдаёт доступ.

Права редактирования GitHub Project назначаются отдельно от доступа
к репозиторию.

## Владельцы файлов

Актуальные правила находятся в [CODEOWNERS](../.github/CODEOWNERS).

| Область | Профильные владельцы | Общие владельцы для ревью |
| --- | --- | --- |
| `web/` | RepinDM | afilistovich, kakocuk1 |
| `web/public/` | RepinDM, zavdaria | afilistovich, kakocuk1 |
| `api/` | RepinDM и владелец соответствующего бэкенд-сервиса | afilistovich, kakocuk1 |
| `docs/qa/`, `.github/ISSUE_TEMPLATE/` | make-smart-products | afilistovich, kakocuk1 |
| `docs/design/` | zavdaria | afilistovich, kakocuk1 |
| Остальные файлы, включая Go-сервисы, deploy и workflows | afilistovich, kakocuk1 | afilistovich, kakocuk1 |

Распределение конкретных задач между двумя бэкендерами фиксируется
в GitHub Issues. Новые каталоги с тестами и материалами дизайна добавляйте
в CODEOWNERS по мере их появления.

## Исполнитель и ревьюер

**Assignee в issue** отвечает за выполнение задачи.
**CODEOWNER** отвечает за ревью изменений в соответствующих файлах.
Эти роли могут принадлежать разным участникам.

Автор PR не может одобрить свои изменения. Поэтому в каждой области
сохранены общие владельцы: например, PR фронтендера по `web/`
может проверить один из бэкендеров.

CODEOWNERS выбирается из целевой ветки PR. После merge этого распределения
GitHub сможет автоматически запрашивать профильных владельцев при открытии
обычного PR или переводе Draft PR в готовый к ревью.
Для уже открытых PR проверьте список Reviewers и при необходимости
добавьте нужных участников вручную.

## Сколько approvals нужно

Ruleset требует минимум **один** approval и одобрение владельцев кода.
Одно одобрение участника, который является владельцем всех изменённых файлов,
выполняет оба требования. Для каждого отдельного правила CODEOWNERS достаточно
approval любого одного указанного владельца.

Если в PR затронуты разные области, одобрения должны покрывать все изменённые
файлы. Общие владельцы `afilistovich` и `kakocuk1` перечислены во всех
правилах и могут провести ревью всего PR.

Для `api/` действует дополнительное командное правило из SPEC §8:
согласование фронтенда и владельца сервиса. Наличие нескольких имён
в одной строке CODEOWNERS автоматически не требует approval от каждого.
Автор PR и ревьюеры проверяют оба согласования отдельно.

Подробные требования к PR и Definition of Done - в
[CONTRIBUTING](../CONTRIBUTING.md).

Справка: [GitHub CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners).
