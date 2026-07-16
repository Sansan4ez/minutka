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

## Эпики (снимок 2026-07-16)

**Активные:**

| Эпик | id | Статус |
|---|---|---|
| Фаза A.3 — активация и персональный контекст пилотного пользователя | `prs-dor` | ready |
| Фаза C.1 — задачи, планирование и фокус дня | `prs-mcn` | blocked by A.3 |
| Фаза D.0 — scheduler foundation и ежедневные касания | `prs-yjl` | blocked by C.1 |
| Фаза E.0 — typed processing сохранённых артефактов | `prs-pdo` | ready |
| Фаза E.1 — встречи и follow-up | `prs-t7c` | blocked by C.1 и E.0 |
| Фаза P — pilot readiness: usage, cost и data lifecycle | `prs-ip0` | ready |

**Отложено до результатов пилота:**

| Эпик | id | Статус |
|---|---|---|
| Post-pilot cleanup — удалить `MinutkaService` и отдельный onboarding-agent | `prs-zgo` | deferred; blocked by `prs-ip0` |

**Закрытые (ассистент):** Фаза A.2 — единый runtime (`prs-jkw`), Фаза B — банк идей (`prs-2yr`), универсальный файловый intake/CAS (`prs-sb1`), гигиена Agent Vault и routing integrity (`prs-x5q`).

**Закрытые (фундамент «Минутки»):** Фазы 1, 2, 3, 3.5, 4, 4.1, 4.2, 5 — `br list --status=closed -t epic`.

Актуальный dependency-aware порядок всегда смотреть через `bv --robot-triage`; roadmap и инварианты фаз — в [RFC §13](../architecture/rfc-personal-assistant-architecture.md#13-фазовый-план).

## Как заводить новый план

- **Новая фаза** = epic (`br create -t epic`); шаги = задачи (`--parent <epic>`, зависимости `br dep add <шаг> <предшественник>`).
- Описание — markdown с заголовками `## Design` и `## Acceptance Criteria` (у epic — `## Success Criteria`); `br lint` держать зелёным.
- **Старые/сделанные планы** переносятся целиком — один эпик без разбивки на задачи, закрытый с reason (тег/коммит).

## Файлы папки

| Файл | Назначение |
|---|---|
| [_plan-template.md](./_plan-template.md) | Шаблон плана (справочно; исполнение — в br) |
| [TODO.md](./TODO.md) | Ручные проверки (smoke/E2E), не покрываемые executable specs |
