# Планирование

Планирование ведётся в **beads** (`br` — issue-трекер, `bv` — граф-триаж; данные в `.beads/`, tracked в git через `issues.jsonl`). Эта папка держит только **шаблон**, этот **README** и **TODO** ручных проверок. Детальные фазовые планы — это **эпики в br** + git history (отдельных `phase-*.md` больше нет).

Правила формата — [../CONVENTIONS.md](../CONVENTIONS.md) (раздел «План → задачи beads»). Шаблон плана (для справки/чернового наброска) — [_plan-template.md](./_plan-template.md).

## Как смотреть план

```bash
br epic status              # прогресс по эпикам (= фазам)
br ready                    # что готово к работе (без блокеров)
bv --robot-triage          # граф-триаж: топ-пики, quick wins, блокеры
br show <id>                # детали задачи: description / ## Design / ## Acceptance Criteria
```

## Целевая архитектура

- [../architecture/rfc-personal-assistant-architecture.md](../architecture/rfc-personal-assistant-architecture.md) + [../architecture/rfc-agent-led-routing.md](../architecture/rfc-agent-led-routing.md) — текущая.
- [../architecture/minutka-foundation.md](../architecture/minutka-foundation.md) — исторический мастер-план фундамента «Минутки» (провенанс переиспользуемого кода).

## Эпики (снимок 2026-07-15)

**Активные:**

| Эпик | id | Статус |
|---|---|---|
| Фаза B — банк идей (slim) | `prs-2yr` | closed |
| Универсальный файловый intake и owner-scoped CAS | `prs-sb1` | open |
| Гигиена роутинга/каталога (F1/F4, ex F1–F8) | `prs-x5q` | open (superseded-остаток) |
| Фаза D — дайджест/планировщик (ex phase-7) | `prs-yjl` | deferred |

**Закрытые (фундамент «Минутки»):** Фазы 1, 2, 3, 3.5, 4, 4.1, 4.2, 5 — `br list --status=closed -t epic`.

**Будущие фазы RFC** (C — планирование, E — встречи, F — совет директоров, G — инсайты) заводятся эпиками по мере подхода — см. roadmap в [RFC §13](../architecture/rfc-personal-assistant-architecture.md#13-фазовый-план).

## Как заводить новый план

- **Новая фаза** = epic (`br create -t epic`); шаги = задачи (`--parent <epic>`, зависимости `br dep add <шаг> <предшественник>`).
- Описание — markdown с заголовками `## Design` и `## Acceptance Criteria` (у epic — `## Success Criteria`); `br lint` держать зелёным.
- **Старые/сделанные планы** переносятся целиком — один эпик без разбивки на задачи, закрытый с reason (тег/коммит).

## Файлы папки

| Файл | Назначение |
|---|---|
| [_plan-template.md](./_plan-template.md) | Шаблон плана (справочно; исполнение — в br) |
| [TODO.md](./TODO.md) | Ручные проверки (smoke/E2E), не покрываемые executable specs |
