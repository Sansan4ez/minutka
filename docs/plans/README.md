# Планирование «Минутки»

Исполнение ведётся в **beads** (`br` — issue-трекер, `bv` — dependency-aware триаж). Данные проекта хранятся в `.beads/` и синхронизируются в tracked-файл `.beads/issues.jsonl`. Эта папка содержит только README и шаблоны: отдельные фазовые планы и ручной `TODO.md` не являются источником истины.

Правила формата — [../CONVENTIONS.md](../CONVENTIONS.md), шаблон черновика эпика — [_plan-template.md](./_plan-template.md), самодостаточная спека исполняемой задачи с примером — [_task-template.md](./_task-template.md).

## Как смотреть актуальный план

```bash
bv --robot-triage --format toon  # приоритеты и блокеры
br ready                         # готовые к исполнению задачи
br list --status=open -t epic    # открытые эпики «Минутки»
br show <mnt-id>                 # scope, Design и Acceptance Criteria
```

Идентификаторы собственного трекера используют префикс `mnt-`. Идентификаторы `prs-*`, фазы D.0/D.1 и другие планы персонального ассистента относятся к исходному репозиторию и не задают roadmap «Минутки».

## Архитектура и планка

- [RFC исследовательского корпуса «Минутки»](../architecture/rfc-minutka-research-corpus-and-reporting.md) — canonical corpus, subject-aware evidence, confidence и client-report boundary;
- [RFC линейки трёх продуктов](../architecture/rfc-three-products-implementation.md) — границы самостоятельных репозиториев и процедура клона;
- [унаследованная архитектура runtime](../architecture/rfc-personal-assistant-architecture.md) + [agent-led routing](../architecture/rfc-agent-led-routing.md) — фундамент typed use-cases и одного agent-led хода;
- [планка качества пилота](../architecture/rfc-pilot-quality-bar.md) — красные линии, один раунд ревью на эпик и integration gate;
- [pilot scenario runbook](../runbooks/pilot-scenario-run.md) — ручной прогон «Минутки».

## Как заводить работу

- Новая поставка = epic: `br create -t epic --title "..."`.
- Конкретные шаги = executable children (`task`, `bug`, `feature`, `chore`, `docs`) с `--parent <epic-id>`.
- Зависимости отражают порядок разблокировки: `br dep add <issue> <depends-on>`.
- Исполняемая задача оформляется по `_task-template.md`: `## Intent`, `## Design`, `## Non-goals`, `## Non-scope`, `## Acceptance Criteria`.
- Intent ≤1200 символов; весь `description` ≤6000, включая пробелы, Markdown и код (условное среднее 1 токен ≈4 символа). Лимит не распространяется на контейнер-эпик.
- Контекст, misfit, необходимые фрагменты файлов с путями/символами/ревизиями уже включены; ссылки не заменяют требования. Сценарии — конкретные входы/выходы и эффекты, NFR — измеримые условия проверки. Не помещается — декомпозируем.
- У эпика — цель, `## Design`, границы и `## Success Criteria`. До claim проверяем контракт готовности из CONVENTIONS; одного зелёного `br lint` недостаточно.
- После реализации задача закрывается, выполняется `br sync --flush-only`, а изменение `.beads/issues.jsonl` входит в тот же атомарный коммит.

Актуальный порядок всегда вычисляется из графа `br`/`bv`; статические таблицы эпиков в документации не поддерживаются.

## Файлы папки

| Файл | Назначение |
|---|---|
| [_plan-template.md](./_plan-template.md) | Шаблон черновика для наполнения epic в `br` |
| [_task-template.md](./_task-template.md) | Спека исполняемой задачи, заполненный пример и readiness-чеклист |
| [README.md](./README.md) | Правила навигации по трекеру «Минутки» |
