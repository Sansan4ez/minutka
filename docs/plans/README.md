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

## Целевая архитектура и планка

- [../architecture/rfc-personal-assistant-architecture.md](../architecture/rfc-personal-assistant-architecture.md) + [../architecture/rfc-agent-led-routing.md](../architecture/rfc-agent-led-routing.md) — текущая архитектура.
- [../architecture/rfc-pilot-quality-bar.md](../architecture/rfc-pilot-quality-bar.md) — планка качества пилота: модель угроз, бюджет ревью (один раунд на эпик), триаж находок.
- [../runbooks/pilot-scenario-run.md](../runbooks/pilot-scenario-run.md) — ручной двухсуточный integration gate D.0 через живой Telegram и живой LLM.
- [../architecture/minutka-foundation.md](../architecture/minutka-foundation.md) — исторический мастер-план фундамента «Минутки» (провенанс переиспользуемого кода).

## Эпики (снимок 2026-07-30)

**Пилотная петля (вход — `prs-yjl.1`):**

| Эпик | id | Статус |
|---|---|---|
| Фаза D.0 — slim scheduler и ежедневные касания | `prs-yjl` | P0, ready; цепочка D0.1 → D0.2 → D0.3 (утро day_focus, вечер evening_reflection) |
| Фаза UX.TG — Telegram-native ответы и интерактивность | `prs-w4z` | TG2 renderer (pilot-path), TG3 typing, TG4 `/new` |
| Фаза P (slim) — usage counter и soft limit | `prs-ip0` | ready: `prs-ip0.1`; export/delete и backup smoke — после запуска |
| Фаза E.0 — typed processing сохранённых артефактов | `prs-pdo` | ready; первый шаг `prs-sb1.4`; референс loaders — eggent-analysis |
| Фаза E.1 — встречи и follow-up | `prs-t7c` | после E.0; референс pipelines — eggent/buzz research |
| Фаза D.1 — утренний персональный дайджест | `prs-jt0` | blocked by D.0; источники: RSS-first без аккаунта владельца (решение 2026-07-30) |
| Фаза DATA — consent и управление записями | `prs-pfc` | открыт DATA2 |

**Отложено до trigger/результатов пилота:**

| Эпик/задача | id | Статус |
|---|---|---|
| `readProcess(id)` и progressive disclosure процессов | `prs-jxy.8` | deferred до 5+ активных процессов или приближения к manual ceiling |
| Post-pilot cleanup — удалить `MinutkaService` и отдельный onboarding-agent | `prs-zgo` | deferred; blocked by `prs-ip0` |
| Локальный STT (whisper.cpp за `SpeechToTextPort`) | `prs-5kyo` | P2; не блокирует пилот, облачный STT работает |
| Фаза F — «Совет директоров» | `prs-uhf` | P3; design-референс — персоны/команды Buzz |
| Corporate track — референсы и пороги зрелости Buzz | `prs-dga7` | P4 backlog-заметка; активация только по триггеру пересмотра планки |

**Закрытые (ассистент):** Фаза A.2 — единый runtime (`prs-jkw`), Фаза A.3 — activation и personal context (`prs-dor`), Фаза B — банк идей (`prs-2yr`), Фаза C.0 — bounded context и document capabilities (`prs-jxy`), Фаза C.1 — задачи, планирование и фокус дня (`prs-mcn`), C1 review hardening (`prs-2usv`; закрыт по планке — дальнейшие ревью-раунды остановлены), универсальный файловый intake/CAS (`prs-sb1`), гигиена Agent Vault и routing integrity (`prs-x5q`).

**Закрытые (фундамент «Минутки»):** Фазы 1, 2, 3, 3.5, 4, 4.1, 4.2, 5 — `br list --status=closed -t epic`.

Актуальный dependency-aware порядок всегда смотреть через `bv --robot-triage`; roadmap и инварианты фаз — в [RFC §13](../architecture/rfc-personal-assistant-architecture.md#13-фазовый-план); триаж новых находок ревью — по [планке качества пилота](../architecture/rfc-pilot-quality-bar.md).

## Как заводить новый план

- **Новая фаза** = epic (`br create -t epic`); шаги = задачи (`--parent <epic>`, зависимости `br dep add <шаг> <предшественник>`).
- Описание — markdown с заголовками `## Design` и `## Acceptance Criteria` (у epic — `## Success Criteria`); `br lint` держать зелёным.
- **Старые/сделанные планы** переносятся целиком — один эпик без разбивки на задачи, закрытый с reason (тег/коммит).

## Файлы папки

| Файл | Назначение |
|---|---|
| [_plan-template.md](./_plan-template.md) | Шаблон плана (справочно; исполнение — в br) |
| [TODO.md](./TODO.md) | Ручные проверки (smoke/E2E), не покрываемые executable specs |
