# План реализации прототипа «Минута» / `time-agent` на базе Mastra

> **Статус:** актуализировано после завершения Phase 1 (`phase-1-skeleton`).  
> **Подробный план Phase 1:** [`phase-1-skeleton-and-test-harness.md`](./phase-1-skeleton-and-test-harness.md).  
> **Подробный план Phase 2:** [`phase-2-onboarding-consent-profile.md`](./phase-2-onboarding-consent-profile.md).  
> **Подробный план Phase 3:** [`phase-3-context-guardrails-insights.md`](./phase-3-context-guardrails-insights.md).  
> **Технический принцип:** docs-first Mastra workflow: перед изменением Mastra API сверяться с embedded docs установленной версии и provider registry.

---

## 1. Цель MVP

Построить простой, надёжный и проверяемый прототип продукта «Минута»: Telegram-бот с AI-партнёром, который помогает сотруднику разбирать и планировать рабочий день, накапливает личный рабочий контекст и формирует обезличенные сигналы для будущей «Карты автоматизации» компании.

MVP проверяет три гипотезы:

1. AI-агент способен удерживать рабочий контекст сотрудника и давать полезную обратную связь.
2. Персоны общения («Поддержка» / «Эффективность») заметно влияют на вовлечённость и субъективную пользу.
3. Из накопленных рефлексий можно извлечь повторяющиеся зоны рутины и кандидаты на автоматизацию без раскрытия личных данных.

Разработка ведётся через **Executable Specs**: каждый значимый пользовательский сценарий фиксируется исполняемой спецификацией, которая проходит весь путь через слои приложения.

---

## 2. Термины и нейминг

Чтобы убрать неоднозначность в документах и коде:

- **Продукт:** «Минута».
- **AI-партнёр / агент в коде:** «Минутка», `MinutkaAgent`, `minutkaAgent`.
- **Репозиторий / пакет:** `time-agent`.
- **Сотрудник:** прямой пользователь Telegram-бота.
- **Компания / руководство:** получает только агрегированную и обезличенную аналитику.
- **Методолог:** оператор программы, управляет потоками и смотрит вовлечённость без доступа к личным диалогам.

---

## 3. Текущий технический baseline

Phase 1 уже реализовала базовый каркас. Дальнейшие этапы должны расширять его без ломки слоёв.

### Runtime и tooling

- **Node.js:** 22 через Nix (`flake.nix`, `.envrc`).
- **TypeScript:** `ES2022`, `moduleResolution: "bundler"`, `strict: true`.
- **Package format:** ESM (`"type": "module"`).
- **Проверки:**
  - `npm run typecheck`
  - `npm run specs`
  - `npm run verify`
  - `nix run .#verify`
- **Spec runner:** Vitest.
- **CLI для executable specs:** `commander`.
- **Runtime validation:** Zod.

### Mastra

- **Framework:** `@mastra/core` + `mastra`.
- **Агент:** `MinutkaAgent`.
- **Стартовая модель:** `openai/gpt-5.4-mini`.
- **Provider registry:** модель подтверждена на Phase 1; при смене модели обязательно повторять проверку registry.
- **Runtime bridge:** `AgentRunner`, чтобы executable specs могли инжектировать mock-runner без LLM/API.

### Слои приложения

Дальше сохраняем архитектуру:

```text
Domain → Application → Server → SDK → CLI / Telegram
                ↓
             Mastra runtime bridge
```

Назначение слоёв:

| Слой | Ответственность |
|---|---|
| `domain` | Типы домена, события, privacy-safe идентификаторы. |
| `application` | Use cases и бизнес-логика: chat, onboarding, feedback, insights. |
| `server/http` | API-surface; сначала in-process, позже можно заменить транспорт. |
| `client/sdk` | Типизированный клиент + Zod validation. |
| `client/cli` | Поверхность для executable specs и отладки. |
| `mastra` | Agent, tools, memory/storage integration, runtime bridge. |
| `telegram` / bot shell | Появляется на Telegram-этапе как отдельная внешняя поверхность, не заменяет SDK/CLI. |

---

## 4. Архитектура продукта

### 4.1 Product Parts

План должен оставаться согласованным с `docs/diagram_modules/product-parts/*`:

| Product Part | В MVP |
|---|---|
| `telegram-bot-shell` | Онбординг, ежедневные текстовые/голосовые сообщения, feedback, настройки. |
| `ai-agent-backend-runtime` | AI-диалог, проверка тематики, персона, контекст, извлечение сигналов, STT/LLM boundary. |
| `data-storage-and-privacy-layer` | Личный контекст, согласия, audit, агрегированные сигналы, privacy projections. |
| `methodologist-web-panel` | За рамками раннего MVP; допускается заменить служебными CLI/скриптами до отдельного этапа. |

### 4.2 Многопользовательская модель

Для прототипа используем один общий `MinutkaAgent`, а не фабрику агентов.

Изоляция пользователей:

- `resourceId` = privacy-safe employee/user id, не ФИО и не внешний идентификатор в открытом виде.
- `threadId` = диалоговый контекст: Telegram chat/thread или внутренний thread id.
- Профиль, persona и privacy/consent состояние подтягиваются до вызова агента и подставляются в инструкции/контекст динамически.

### 4.3 Данные и приватность

На MVP данные могут храниться в одной физической БД, но логически разделяются:

1. **Personal context** — профиль, persona, история, рабочие паттерны, consent.
2. **Dialogue/event log** — сообщения, ответы, feedback, доменные события.
3. **Structured insights** — извлечённые категории задач, рутина, энергия/стресс, automation candidates.
4. **Aggregates** — безопасные обезличенные срезы для компании и методолога.

Правила:

- Компания не получает личные диалоги, ФИО, индивидуальные задачи или эмоциональное состояние конкретного сотрудника.
- Для любой видимой агрегированной аналитики действует минимальный размер группы: **не меньше 5 сотрудников**.
- `employeeId` в коде считается псевдонимом; связь с внешними персональными данными должна быть отделена.
- Шифрование, KMS, сложный audit и retention policy остаются вне раннего MVP, но структура не должна мешать их добавлению.

---

## 5. Примитивы Mastra

### 5.1 Agent: `MinutkaAgent`

Один агент с базовыми инструкциями и динамическим контекстом.

Базовые ограничения:

- Слушает, отражает, помогает структурировать рабочий день.
- Замечает закономерности в работе и эмоциях.
- Напоминает о приоритетах и помогает сформулировать следующий шаг.
- Не пишет тексты, посты, КП, письма и другие рабочие материалы за сотрудника.
- Не делает web research.
- Не обучает ИИ-инструментам, если сотрудник не готов или не просит сам.
- Не контролирует, не оценивает, не давит.
- Отвечает только в границах рабочего дня и связанного с работой состояния.

Persona меняет тон, но не отменяет ограничений.

### 5.2 Tools

Планируемые инструменты:

| Tool | Этап | Назначение |
|---|---:|---|
| `updateProfileTool` | Phase 2 | Создать/обновить профиль: роль, задачи, persona, AI level, предпочтения. |
| `extractInsightsTool` | Phase 3 | Извлечь структурированные сигналы: категории задач, рутина, энергия/стресс, automation candidates. |
| `recordFeedbackTool` или application use case | Phase 4 | Сохранить 👍/👌/👎 по ответу агента. Решение: tool или service зависит от реализации Telegram flow. |

Важно: executable specs не должны зависеть от реального LLM. Для проверки tool-побочных эффектов использовать mock-agent/mock-tool runner, а Mastra smoke проверять отдельно.

### 5.3 Memory / Storage

Переход по этапам:

1. **Phase 1:** `InMemoryWorld` только для executable specs и каркаса.
2. **Phase 2:** добавить persistent storage для профилей/consent/onboarding. SQLite допустим как старт.
3. **Phase 3:** подключить Mastra Memory для `resourceId` + `threadId` и проверить удержание контекста.
4. **Позже:** PostgreSQL, если потребуется мультипользовательская нагрузка и отчётность.

Перед использованием конкретного Mastra storage/memory API необходимо свериться с embedded docs установленного `@mastra/core`.

---

## 6. Executable Specs: ключевые сценарии

### `SPEC-SKELETON-001` — каркас и полный путь CLI → SDK → Server → Service → AgentRunner

**Статус:** реализовано на Phase 1.

- Smoke import: `mastra` и `minutkaAgent` импортируются без ошибок.
- CLI `employee chat` принимает текст сотрудника.
- SDK валидирует request/response через Zod.
- Service эмитит `ChatMessageReceived` и `ChatResponseGenerated`.
- AgentRunner инжектируется как mock; LLM/API не требуются.

### `SPEC-ONBOARDING-001` — онбординг, согласие и профиль

- **Given** новый участник пришёл по invite/deep-link и ещё не имеет профиля.
- **When** он подтверждает участие, принимает privacy explanation, отвечает на стартовые вопросы и выбирает persona «Эффективность».
- **Then** профиль сохраняется с privacy-safe `employeeId`, consent фиксируется, persona влияет на следующий ответ агента.

### `SPEC-CONTEXT-001` — утренний план → вечерняя рефлексия

- **Given** сотрудник с профилем и включённой memory.
- **When** утром пишет: «Сегодня приоритет — закрыть квартальный отчёт».
- **And** вечером пишет: «Отчёт не успел, весь день на звонках».
- **Then** ответ ссылается на утренний план, а insight фиксирует «звонки» как повторяющийся/мешающий паттерн и возможный маркер усталости.

### `SPEC-GUARDRAILS-001` — ограничение тематики

- **Given** сотрудник с профилем.
- **When** он просит: «Напиши мне пост для соцсети».
- **Then** агент мягко отказывает и возвращает разговор к теме рабочего дня.
- **And** `extractInsightsTool` не создаёт рабочий insight из нерелевантного запроса.

### `SPEC-FEEDBACK-001` — обратная связь по ответу

- **Given** агент дал ответ на сообщение сотрудника.
- **When** сотрудник нажимает 👍/👌/👎.
- **Then** оценка сохраняется и привязывается к ответу, сотруднику, thread и timestamp.

### `SPEC-VOICE-001` — голосовое сообщение как эквивалент текста

- **Given** сотрудник отправляет voice message.
- **When** STT boundary возвращает транскрипт.
- **Then** транскрипт проходит тот же chat/use-case путь, что и текст, а исходное voice-событие связано с сообщением.

### `SPEC-AUTOMATION-MAP-001` — обезличенная карта автоматизации

- **Given** в storage есть insights от ≥5 сотрудников за ≥5 дней.
- **When** запускается служебная агрегация.
- **Then** формируется Markdown-отчёт: топ рутинных задач, зоны стресса/нагрузки, automation candidates.
- **And** отчёт не содержит личных имён, транскриптов и срезов меньше 5 сотрудников.

---

## 7. Этапы реализации

Каждый этап следует циклу:

```text
написать/уточнить spec → запустить (красный) → реализовать минимальный код → spec зелёный → typecheck → nix run .#verify → коммит/тег
```

### Phase 1 — Скелет проекта и test harness

**Статус:** ✅ завершено.  
**Тег:** `phase-1-skeleton`.  
**Детали:** [`phase-1-skeleton-and-test-harness.md`](./phase-1-skeleton-and-test-harness.md).

Результат:

- Nix + Node 22.
- TS/ESM проект.
- Слои `domain`, `application`, `server`, `client/sdk`, `client/cli`, `mastra`.
- `MinutkaAgent` с `openai/gpt-5.4-mini`.
- `AgentRunner` bridge.
- `SPEC-SKELETON-001`.
- `nix run .#verify` проходит.

### Phase 2 — Онбординг, consent и профиль

**Подробный план:** [`phase-2-onboarding-consent-profile.md`](./phase-2-onboarding-consent-profile.md).  
**Цель:** сотрудник может быть зарегистрирован, принять privacy explanation, выбрать persona и получить первый ответ в выбранном стиле.

Минимальный scope:

1. Расширить domain: `Participant`, `Consent`, `UserProfile`, onboarding events.
2. Расширить `InMemoryWorld` и application service под onboarding.
3. Добавить API/SDK/CLI команды для onboarding flow.
4. Реализовать `updateProfileTool` или application-level profile updater.
5. Добавить динамический prompt/context builder для persona и AI level.
6. Подготовить persistent storage interface, но допускается in-memory adapter для spec.
7. Написать `SPEC-ONBOARDING-001`.

Definition of Done:

- `SPEC-ONBOARDING-001` зелёная.
- `SPEC-SKELETON-001` остаётся зелёной.
- `npm run typecheck`, `npm run specs`, `nix run .#verify` проходят.
- Коммит и тег `phase-2-onboarding`.

### Phase 3 — Контекст, guardrails и извлечение инсайтов

**Подробный план:** [`phase-3-context-guardrails-insights.md`](./phase-3-context-guardrails-insights.md).  
**Цель:** агент удерживает контекст дня, соблюдает границы тематики и сохраняет структурированные сигналы.

Минимальный scope:

1. Подключить/обернуть Mastra Memory для `resourceId` + `threadId`.
2. Реализовать `extractInsightsTool` или deterministic extractor boundary с mock для specs.
3. Добавить domain types для insights: task category, routine pattern, energy/stress marker, automation candidate.
4. Добавить guardrail/policy слой перед insight extraction.
5. Написать `SPEC-CONTEXT-001` и `SPEC-GUARDRAILS-001`.

Definition of Done:

- Context spec подтверждает ссылку на утренний план.
- Guardrails spec подтверждает отказ и отсутствие нерелевантного insight.
- Все предыдущие specs зелёные.
- Коммит и тег `phase-3-context-insights`.

### Phase 4 — Telegram shell: текстовый MVP и feedback

**Цель:** рабочий Telegram-бот с текстовым вводом, `/start`, onboarding entrypoint и feedback buttons.

Минимальный scope:

1. Добавить Telegram adapter (`telegraf`) и `.env.example` ключ `TELEGRAM_BOT_TOKEN` уже есть.
2. Реализовать обработчики `/start`, текстовых сообщений, callback buttons 👍/👌/👎.
3. Не помещать бизнес-логику в handlers: handlers вызывают SDK/Application API.
4. Добавить `SPEC-FEEDBACK-001` через in-process Telegram adapter/mock update driver.
5. Провести ручной smoke E2E в Telegram.

Definition of Done:

- Text Telegram flow работает вручную.
- Feedback сохраняется и связан с ответом.
- Specs зелёные без реального Telegram/API.
- Коммит и тег `phase-4-telegram-text-feedback`.

### Phase 5 — Голосовые сообщения и STT boundary

**Цель:** voice message обрабатывается как текст после транскрипции.

Минимальный scope:

1. Добавить STT boundary/interface.
2. Реализовать Telegram voice handler: metadata → download boundary → STT boundary → chat flow.
3. Для specs использовать mock STT, без реального Whisper/API.
4. Написать `SPEC-VOICE-001`.

Definition of Done:

- Voice и text сходятся в один application use case.
- Specs не требуют реального OpenAI key.
- Ручной Telegram voice smoke успешен.
- Коммит и тег `phase-5-voice-stt`.

### Phase 6 — Карта автоматизации

**Цель:** агрегировать insights в обезличенный Markdown-отчёт для компании/методолога.

Минимальный scope:

1. Реализовать aggregation service/script.
2. Ввести privacy projection: запрет срезов меньше 5 сотрудников.
3. Сгенерировать Markdown report из mock/fixture insights.
4. Написать `SPEC-AUTOMATION-MAP-001`.

Definition of Done:

- Отчёт не содержит личных данных и малых срезов.
- Spec проходит на мок-данных ≥5 пользователей.
- Коммит и тег `phase-6-automation-map`.

### Phase 7 — Расписание и ежедневные касания (опционально для MVP)

**Цель:** автоматические morning / optional midday / evening prompts.

Минимальный scope:

1. Scheduler boundary (`node-cron` или platform scheduler).
2. Настройки времени и timezone сотрудника.
3. Idempotency: не отправлять дубликаты.
4. Spec на scheduled prompt без реального времени через fake clock.

Definition of Done:

- Scheduled prompts проверяются deterministically.
- Telegram delivery mock проходит spec.
- Коммит и тег `phase-7-scheduling`.

### Phase 8 — Methodologist/admin surface (после MVP или отдельный продуктовый трек)

**Цель:** заменить служебные CLI/скрипты поверхностью для методолога.

Scope уточняется отдельно. До этого этапа допустимо работать через CLI/Markdown artifacts.

---

## 8. Сквозные инженерные правила

1. **Не ломать слои.** Новые user flows проходят через Application/API/SDK; Telegram handler не должен становиться бизнес-слоем.
2. **Specs без внешних API.** LLM, Telegram и STT мокируются в specs через boundary/runner interfaces.
3. **Mastra docs-first.** Перед использованием Agent/Tool/Memory/Storage API читать embedded docs установленной версии.
4. **Provider registry first.** Любая новая модель проверяется через provider registry.
5. **Privacy by structure.** Сначала доменные типы и privacy-safe projections, потом отчёты.
6. **Минимальные коммиты по фазам.** Каждый этап заканчивается зелёным `nix run .#verify` и тегом.
7. **Не создавать `tests/unit`, `tests/contract`, `tests/integration` без отдельного решения.** Основной тестовый контур MVP — `specs/executable`.

---

## 9. Что за рамками раннего MVP

- Шифрование данных, KMS, полноценный compliance audit log.
- Веб-панель методолога и rich admin UI.
- CRM/календарь/таск-трекер интеграции.
- Генерация рабочих материалов за сотрудника.
- Мобильное приложение.
- Недельные и финальные персональные отчёты в полном продуктовом виде.
- B2C-версия.
- Автоматическое дообучение моделей на данных сотрудников.

---

## 10. Основные риски и решения

| Риск | Решение |
|---|---|
| Mastra API меняется между версиями | Embedded docs + typecheck перед реализацией каждого Mastra feature. |
| LLM нестабилен в specs | Specs используют mock runners/tools; LLM проверяется smoke/eval отдельно. |
| Telegram handlers начнут содержать бизнес-логику | Ввести Telegram adapter/driver, который вызывает SDK/Application API. |
| Privacy нарушится при отчётах | Privacy projection и минимум 5 сотрудников проверяются executable spec. |
| Storage выбор преждевременно усложнит MVP | Начать с interfaces + SQLite/in-memory adapters; PostgreSQL только при необходимости. |
| Модель `openai/gpt-5.4-mini` станет недоступной | Stop-and-confirm: проверить registry и согласовать замену, не менять молча. |
