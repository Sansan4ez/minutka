# Индекс планов реализации

Навигация по `docs/plans/`. Проект пивотнул из узкого продукта **«Минутка»** (`time-agent`) в **персонального AI-ассистента**; ассистент **переиспользует** фундамент «Минутки» (application-слой, stores, decision router, Agent Vault, runtime). Поэтому здесь соседствуют активный roadmap ассистента и исторические планы фундамента.

- **Текущая целевая архитектура:** [../architecture/rfc-personal-assistant-architecture.md](../architecture/rfc-personal-assistant-architecture.md) + [rfc-agent-led-routing.md](../architecture/rfc-agent-led-routing.md) (агент-ведомый роутинг — уточняет §8, основной для роутинга навыков).
- **Правило:** при составлении плана каждой следующей фазы держаться агент-ведомой модели (`rfc-agent-led-routing.md`): агент сам роутит в один ход, машинерию не наращивать. Заход F1–F8 как предусловие фаз **не делать** — большинство пунктов растворяется (см. §6 нового RFC).

---

## 🟢 Активные планы (ассистент)

Актуальный roadmap. Строятся на RFC; фазы идут по буквам (A–G, RFC §13).

| Документ | Что | Статус |
|---|---|---|
| [fix-routing-catalog.md](./fix-routing-catalog.md) | Исправление роутинга/каталога процессов (F1–F8) | **superseded** [rfc-agent-led-routing.md](../architecture/rfc-agent-led-routing.md): большинство пунктов растворяется, F2 больше не предшественник B; остаются F1/F4 как гигиена |
| [phase-b-idea-bank.md](./phase-b-idea-bank.md) | Фаза B «Банк идей»: `IdeaStore`, `Classified`, инструмент `captureIdea` | **rewriting → slim** (агент + один tool, без классификатора-агента и без предусловия F2) |

> Фаза A (каркас личного vault: MinIO-адаптеры, `IngestionService`, `AssistantService`, `/proc/context`) **реализована** — коммит `500cc65`, отдельного плана-документа не имеет (описана в RFC §13). Планы фаз C–G появятся здесь по мере подхода к ним.

---

## 📜 Фундамент «Минутки» (historical, не активный roadmap)

Провенанс переиспользуемого кода. Фазы 1–5 / 4.1 / 4.2 **сделаны**, теги существуют. Не расширять в терминах «Минутки» — новое строится по RFC.

| Документ | Что | Статус |
|---|---|---|
| [time-agent-mastra-plan.md](./time-agent-mastra-plan.md) | **Мастер-план «Минутки»** (фазы 1–8); содержит баннер о пивоте и отображение старых фаз на фазы ассистента | historical |
| [phase-1-skeleton-and-test-harness.md](./phase-1-skeleton-and-test-harness.md) | Каркас, слои, `AgentRunner`, executable specs | ✅ done (`phase-1-skeleton`) |
| [phase-2-onboarding-consent-profile.md](./phase-2-onboarding-consent-profile.md) | Онбординг, consent, профиль, persona | ✅ done (`phase-2-onboarding`) |
| [phase-3-context-guardrails-insights.md](./phase-3-context-guardrails-insights.md) | Контекст, guardrails, извлечение инсайтов | ✅ done (`phase-3-context-insights`) |
| [phase-3.5-agent-manual-lite.md](./phase-3.5-agent-manual-lite.md) | Agent Vault: бизнес-процессы как код | ✅ done (`phase-3.5-agent-manual-lite`) |
| [phase-4-telegram-text-feedback.md](./phase-4-telegram-text-feedback.md) | Telegram shell: текст + feedback | ✅ done (`phase-4-telegram-text-feedback`) |
| [phase-4.1-durable-runtime-foundation.md](./phase-4.1-durable-runtime-foundation.md) | PostgreSQL stores, `/proc`/`/run` projections | ✅ done (`phase-4.1-durable-runtime-foundation`) |
| [phase-4.2-http-application-api.md](./phase-4.2-http-application-api.md) | Authenticated HTTP API `/v1`, shared runtime | ✅ done (`phase-4.2-http-application-api`) |
| [phase-5-voice-stt.md](./phase-5-voice-stt.md) | Голос → STT → тот же chat-путь | ✅ done (`phase-5-voice-stt`) |

---

## 🟡 Отложено / к порту

| Документ | Что | Статус |
|---|---|---|
| [phase-7-scheduling.md](./phase-7-scheduling.md) | Reference-дизайн планировщика (в терминах «Минутки») | **не портирован**; реализуется как RFC **Фаза D «Дайджест»** после B и C. Ядро (таблица + тик + `SKIP LOCKED` + luxon) переживает порт; дельта — в баннере документа |

> Старые Phase 6 «Карта автоматизации» и Phase 8 «Панель методолога» из мастер-плана отдельных документов не имеют: Phase 6 → RFC **Фаза G** `context_insights` (индивидуальная карта, без company-агрегации); Phase 8 в single-owner-продукте не нужна.

---

## 🧪 Ручные проверки

| Документ | Что |
|---|---|
| [TODO.md](./TODO.md) | План **ручных проверок** (smoke/E2E), которые нельзя закрыть executable specs: реальный онбординг и заполнение профиля и т.п. Дополняется по ходу фаз |
