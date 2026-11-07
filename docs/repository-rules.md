# Правила репозитория

T03 добавляет правила работы через PR и защиту `main`.
Настройки GitHub применяются отдельно от merge файлов документации.

## Защита main

Активный ruleset `protect-main` предназначен только для `refs/heads/main`.
Список bypass пуст: администраторы также соблюдают правила.

- Все изменения проходят через PR с минимум одним approval другого участника.
- Если для файлов есть CODEOWNERS, нужен approval владельца кода.
- Новые изменения, требующие ревью, сбрасывают устаревшие approvals.
- Все обсуждения в ревью должны быть закрыты.
- **Go lint** и **Go test** обязательны; источник проверок — GitHub Actions
  (integration ID `15368`).
- Перед merge ветка должна учитывать последнюю версию `main`.
- Force push и удаление `main` запрещены.
- Для новых изменений требуется линейная история; merge разрешён только через squash.

Ранее созданные merge-коммиты остаются в истории. Правило линейной истории
применяется к новым изменениям.

## Параметры merge

В репозитории разрешён только `Squash and merge`; merge commit и rebase merge
выключены. Ветка PR автоматически удаляется после merge.

## Источники конфигурации

- `.github/main-ruleset.json` — тело запроса создания ruleset.
- `.github/repository-settings.json` — параметры merge для репозитория.

Администратор применяет подготовленные настройки через GitHub CLI.
Для первого создания ruleset, когда такого правила ещё нет:

```bash
gh api --method PATCH repos/messenger-go-team/messenger \
  --input .github/repository-settings.json

gh api --method POST repos/messenger-go-team/messenger/rulesets \
  --input .github/main-ruleset.json
```

Для обновления существующего ruleset сначала получите его ID и используйте PUT,
а не повторный POST:

```bash
gh api repos/messenger-go-team/messenger/rulesets
gh api --method PUT repos/messenger-go-team/messenger/rulesets/RULESET_ID \
  --input .github/main-ruleset.json
```

Изменения настроек сначала готовятся как конкретный diff конфигурации.
Перед применением проверьте актуальные правила GitHub, чтобы сохранить
параллельные изменения другого администратора.

## Проверка результата

В Settings → Rules → Rulesets должен быть активен `protect-main` для `main`.
У открытого PR до approval merge блокируется даже при зелёном CI.
В Settings → General → Pull Requests доступен только squash merge.

Ревьюеры определяются по CODEOWNERS из целевой ветки.
Автоматический запрос ревью по новому CODEOWNERS начнётся после его merge в `main`.

Источник: [T03](https://github.com/messenger-go-team/messenger/issues/3),
[SPEC §8–10](SPEC.md),
[GitHub: rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets),
[GitHub: CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners).
