# RFC: Что взять из `ecom1-process-architect` для прототипа `time-agent`

- **Дата:** 2026-07-08
- **Статус:** Draft / Research RFC
- **Репозиторий-источник:** `/home/admin/repo/ecom1-process-architect`
- **Целевой репозиторий:** `/home/admin/time-agent`
- **Контекст:** прототип продукта «Минута» / `MinutkaAgent` на базе Mastra

---

## 1. Executive summary

`ecom1-process-architect` — это архитектура агента, где рабочие инструкции не являются одним большим промптом. Они оформлены как **версионируемая кодовая база бизнес-процессов**.

Главная идея репозитория:

> Устойчивый агент строится не через наращивание монолитного system prompt, а через декомпозицию поведения на маленькие, независимые, версионируемые, проверяемые instruction units / business processes.

Для нашего прототипа `time-agent` полезно взять не BitGN-специфичный harness и не Python/Claude CLI-инфраструктуру, а архитектурный паттерн:

1. **Agent manual as code** — операционный мануал агента как набор файлов.
2. **Process index/router** — отдельный индекс, выбирающий релевантные процессы.
3. **Core contract** — общие правила приватности, границ и runtime/tools.
4. **Author contract** — единый формат написания процессных инструкций.
5. **Privacy ledger** — аналог evidence ledger для контроля персональных и агрегируемых данных.
6. **Selected-process audit** — запись того, какие процессы были выбраны для ответа.
7. **Eval-driven evolution** — улучшение процессов через executable specs и human-in-loop review.

Что **не стоит брать сейчас**:

- полный Python orchestrator;
- Claude CLI как runtime-зависимость;
- автономную очередь Process Architect;
- conflict rebase;
- полный world baseline / relocation map;
- тяжёлую immutable-версионизацию всех инструкций на первом этапе.

Рекомендованный ближайший шаг:

> Создать в `time-agent` лёгкий `docs/agent-manual/` и вынести базовые правила «Минутки» из одного общего промпта в 4–6 маленьких процессов: onboarding, privacy, evening reflection, guardrails, insight extraction, feedback.

---

## 2. Что было изучено

Ключевые файлы и зоны репозитория `ecom1-process-architect`:

- `README_RU.md` — идея «бизнес-процессы как код».
- `ARCHITECTURE_RU.md` — архитектура Executor / Process Architect / Instruction Store / Resolver / drift attention.
- `OPERATING_RU.md` — запуск, параметры, структура task_dir.
- `instructions/registry.json` — список версионируемых instruction units.
- `instructions/world.json` — карта файлов мира, от которых зависят процессы.
- `instructions/units/*/vNNNN/` — immutable-версии бизнес-процессов.
- `instructions/units/executor_core/v0018/content.md` — ядро Executor.
- `instructions/prompts/process_architect/*` — промпты Process Architect.
- `orchestrator/main.py` — главный цикл trial → task_dir → resolver → executor → PA.
- `orchestrator/instructions/resolver.py` — подбор версий инструкций и attention-пакеты.
- `orchestrator/instructions/store.py` — модель instruction store.
- `orchestrator/instructions/versioning.py` — запись новых immutable-версий.
- `orchestrator/instructions/pa_queue.py` — очередь Process Architect.
- `orchestrator/mcp_python_server.py`, `static-instructions/runtime_prelude.py`, `static-instructions/workspace.py` — единая runtime-граница `execute_python`.

Для архитектурного обзора был построен `.belief_map.sexp` репозитория. Карта показала 41 Python-файл и основные модули:

- `orchestrator/main`
- `orchestrator/bootstrap`
- `orchestrator/instructions/resolver`
- `orchestrator/instructions/store`
- `orchestrator/instructions/pa_workdir`
- `orchestrator/instructions/pa_runner`
- `orchestrator/mcp_python_server`

---

## 3. Главные архитектурные принципы `ecom1-process-architect`

### 3.1. Инструкции агента как код

Вместо монолитного промпта используется **Instruction Store**:

```text
instructions/
  registry.json
  world.json
  units/
    executor_core/
      v0018/
        content.md
        manifest.json
        changes.md
        diff.patch
        dependency_snapshot/
    bp_checkout/
      v0001/
      v0002/
      ...
    bp_refs/
    bp_submission_terminal/
    ...
```

Каждый instruction unit содержит:

- `content.md` — текст инструкции;
- `manifest.json` — версия, parent, dependencies, rationale, rollback;
- `changes.md` — человеческое объяснение изменения;
- `diff.patch` — diff относительно предыдущей версии;
- `dependency_snapshot/` — снимок источников, на которых основан unit.

Ключевой эффект: промпт перестаёт быть «магическим текстом» и становится инженерным артефактом с историей, зависимостями и ответственностью.

### 3.1.1. Что из этого уже закрывает git в `time-agent`

Для `ecom1-process-architect` отдельные `vNNNN/` директории, `manifest.json`, `diff.patch` и `dependency_snapshot/` оправданы: там есть автономный Process Architect, runtime resolver, hash matching, fallback на старые версии и необходимость доказывать, против какого состояния мира была написана инструкция.

Для нашего MVP это преждевременно. Пока разработка human-in-loop, а все продуктовые документы, specs и process-файлы лежат в одном git-репозитории, большую часть функций Instruction Store уже закрывает обычный git.

| Артефакт ECOM instruction unit | Как закрываем в `time-agent` на MVP |
|---|---|
| `content.md` | Сам process-файл: `docs/agent-manual/processes/evening_reflection.md` |
| `manifest.json.version` | git commit hash / tag / branch |
| `manifest.json.parent` | родительский git commit |
| `manifest.json.dependencies` | секция `## Dependencies` в process-файле и/или `docs/agent-manual/registry.json` |
| `manifest.json.rationale` | commit message, PR/changeset description, RFC, plan update |
| `manifest.json.rollback` | `git revert <commit>` плюс короткая rollback-заметка в commit/PR при необходимости |
| `changes.md` | `git log`, commit message, RFC/changelog только если станет нужно |
| `diff.patch` | `git diff`, `git show <commit>` |
| `dependency_snapshot/` | обычно не нужен, пока источники тоже в git; нужен позже для external/remote docs или сильного drift-а |

Практический вывод для `time-agent`:

- не создавать сейчас `units/<id>/vNNNN/`;
- хранить Agent Manual как обычные Markdown-файлы под git;
- держать минимальный machine-readable `registry.json`, чтобы specs могли проверить существование process-файлов и dependencies;
- использовать `git diff`, `git show`, `git blame`, `git revert` как основной механизм истории, diff-а и rollback;
- вернуться к immutable store только при появлении реальной боли: автономный Process Architect, external/remote policies, много клиентских вариантов мира, hash-based drift detection.

Минимальный формат на MVP:

```text
docs/agent-manual/
  registry.json
  core.md
  author-contract.md
  processes/
    index.md
    onboarding.md
    consent_and_privacy.md
    evening_reflection.md
    workday_guardrails.md
    insight_extraction.md
    feedback.md
```

Пример dependency-секции внутри process-файла:

```md
## Dependencies

- `docs/product/agent-minutka-brief.md` — продуктовая рамка роли «Минутки».
- `docs/product/virtual-simulation.md` — сценарии поведения и границы shell/backend/privacy.
- `docs/plans/time-agent-mastra-plan.md` — технические границы MVP и phase plan.
- `specs/executable/context/SPEC-CONTEXT-001.spec.ts` — проверяемый сценарий контекста.
```

Пример `registry.json`:

```json
{
  "processes": [
    {
      "id": "evening_reflection",
      "path": "processes/evening_reflection.md",
      "kind": "business_process",
      "dependsOn": [
        "docs/product/agent-minutka-brief.md",
        "docs/product/virtual-simulation.md",
        "docs/plans/time-agent-mastra-plan.md"
      ]
    }
  ]
}
```

Команды, которые заменяют ECOM-артефакты на MVP:

```bash
git log -- docs/agent-manual/processes/evening_reflection.md
git show <commit>
git diff HEAD~1 -- docs/agent-manual/processes/evening_reflection.md
git blame docs/agent-manual/processes/evening_reflection.md
git revert <commit>
```

Итоговое правило:

> **Git-versioning first.** До отдельного решения достаточно стандартного git-versioning process-файлов; не вводить `vNNNN` store, `diff.patch` и `dependency_snapshot/` преждевременно.

### 3.2. Декомпозиция по бизнес-процессам

В ECOM-агенте есть ядро и набор бизнес-процессов:

- `executor_core`
- `bp_index`
- `bp_identity_and_auth`
- `bp_privacy_and_disclosure`
- `bp_refs`
- `bp_submission_terminal`
- `bp_product_discovery`
- `bp_checkout`
- `bp_discount`
- `bp_returns`
- `bp_availability_and_inventory`
- и т.д.

Executor не читает всё подряд. Он обязан:

1. открыть `business_processes/index.md`;
2. по индексу выбрать нужные процессы;
3. открыть только 1–3 релевантных process-файла;
4. выполнить задачу.

Это снижает переполнение контекста, уменьшает противоречия в инструкциях и делает поведение агента более аудируемым.

### 3.3. Детерминированный orchestrator + LLM только для рассуждения

В репозитории жёстко разделены зоны ответственности:

| Компонент | Исполнитель | Ответственность |
|---|---|---|
| Orchestrator | Python-код | task_dir, запуск trial, отчёты, очереди |
| Resolver | Python-код | выбор версий инструкций |
| Fingerprints | Python-код | сравнение мира с baseline |
| Executor | LLM | решение пользовательской задачи |
| Process Architect | LLM | улучшение процессов |
| Versioning | Python-код | запись новых версий |

LLM не управляет всей инфраструктурой напрямую. Она получает подготовленный task_dir и работает внутри ограниченных правил.

Для `time-agent` это хорошо ложится на уже выбранную слоистую архитектуру:

```text
Domain → Application → Server → SDK → CLI / Telegram
                ↓
             Mastra runtime bridge
```

Вывод: LLM должна получать не весь мир, а подготовленный контекст и выбранные playbooks/processes.

### 3.4. Один контролируемый runtime boundary

Executor в ECOM не имеет прямого shell-доступа. У него один runtime-инструмент:

```text
mcp__ecom-python__execute_python
```

Через него он:

- читает live workspace;
- вызывает `/bin/*`;
- делает SQL;
- пишет результат;
- вызывает `submit_and_exit`.

В `runtime_prelude.py` есть:

- `ws` — Workspace API;
- `scratchpad` — постоянный audit trail;
- `state` — рабочее состояние;
- `submit_and_exit(...)` — единственный правильный terminal call.

Для `time-agent` не нужно копировать `execute_python` буквально. Но принцип важен:

> Агент не должен иметь бесконтрольный доступ ко всем действиям. Он должен работать через маленький набор typed tools/use cases.

В нашем проекте это соответствует:

- `updateProfileTool`;
- `extractInsightsTool`;
- будущему `recordFeedbackTool`;
- application use cases вместо произвольных действий агента.

### 3.5. Resolver: match-or-fallback

`resolver.py` выбирает версию каждого unit по зависимостям:

1. Берёт latest active versions.
2. Проверяет dependencies по `sha256`.
3. Если зависимости совпали — unit считается `matched`.
4. Если нет — выбирается latest fallback.
5. Executor получает warning/attention: инструкция может быть устаревшей.
6. Опционально запускается Process Architect для refresh.

Для нашего прототипа полный `sha256` resolver преждевременен. Но стоит взять идею:

- у каждого process-файла есть `dependsOn`;
- при изменении product/privacy/spec docs понятно, какие процессы нужно пересмотреть;
- CI может подсвечивать stale-process warnings.
- очень похоже на отслеживание версий связанных библиотек в коде - изучить опыт архитектуры и принципов контроля версий и зависимостей в UnixOS.

### 3.6. Attention-пакет

Когда мир изменился, Executor получает не только старую инструкцию, но и компактное предупреждение:

- какие файлы изменились;
- где diff;
- какие процессы могут быть stale;
- что live/current source важнее старого текста.

Для `time-agent` аналог:

- изменилась privacy policy;
- изменился product brief;
- изменилась persona/тональность;
- пользователь обновил профиль;
- компания/поток поменяли правила программы.

Агенту не надо пересказывать весь мир. Достаточно передать компактный `attention` block.

### 3.7. Process Architect как отдельный агент-инженер

В ECOM есть второй LLM-агент — Process Architect. Он не решает пользовательские задачи. Он улучшает инструкции.

Режимы:

- `failure_fix` — исправить процесс после провала;
- `fix_blind` — исправить по trace без score;
- `refresh` — обновить unit при изменении зависимости;
- `world_refresh` — обновить карту процессов при изменении мира;
- `world_create` — пересобрать карту процессов с нуля.

PA обязан:

- определить owning layer;
- не хардкодить trial literals;
- менять минимальный нужный unit;
- писать `pa-decision.json`;
- указывать dependencies, rationale, rollback;
- не писать напрямую в instruction store — это делает deterministic code.

Для `time-agent` это перспективно, но полный автономный PA не нужен на первом этапе. Нужна облегчённая human-in-loop версия.

---

## 4. Что применимо к `time-agent`

## 4.1. Уровень A — взять сразу

### A1. Модульный manual вместо одного большого prompt

Не стоит наращивать один огромный system prompt для `MinutkaAgent`. Лучше добавить:

```text
docs/agent-manual/
  registry.json
  core.md
  author-contract.md
  processes/
    index.md
    onboarding.md
    consent_and_privacy.md
    morning_planning.md
    midday_checkin.md
    evening_reflection.md
    workday_guardrails.md
    profile_update.md
    insight_extraction.md
    automation_signal.md
    feedback.md
    weekly_review.md
```

На первом этапе это может быть markdown-manual без сложной runtime-версионизации.

### A2. Process author contract

В ECOM есть `bp_author_contract.md`, который задаёт структуру каждого business-process файла.

Для `time-agent` предлагаемый формат:

```md
# Process name

## When this process applies

## Inputs

## Process

## Outputs

## Privacy notes

## Anti-patterns

## Dependencies
```

Пример для `evening_reflection.md`:

```md
# Evening reflection

## When this process applies
Когда сотрудник подводит итог рабочего дня.

## Inputs
- employee profile
- today's conversation summary
- latest plan
- current message

## Process
1. Отрази, что услышала.
2. Выдели 1–3 события дня.
3. Аккуратно спроси про незавершённое.
4. Не оценивай сотрудника.
5. Если есть стресс — поддержи, но не уходи в терапию.
6. Если есть повторяющаяся рутина — пометь как automation candidate.

## Outputs
- user-facing response
- optional profile updates
- optional insights

## Privacy notes
Что можно сохранять лично, что можно агрегировать.

## Anti-patterns
- Не давить.
- Не контролировать.
- Не писать рабочие материалы вместо сотрудника.
- Не обещать руководству личные данные.

## Dependencies
- docs/product/agent-minutka-brief.md
- docs/plans/time-agent-mastra-plan.md
```

### A3. Process index/router

Нужен `processes/index.md`:

```md
# Minutka process index

| User situation | Read process |
|---|---|
| Новый сотрудник / invite / первое сообщение | onboarding.md + consent_and_privacy.md |
| Утренний план | morning_planning.md |
| Дневная сверка | midday_checkin.md |
| Вечерний разбор | evening_reflection.md |
| Просьба написать пост/КП/письмо | workday_guardrails.md |
| Пользователь сообщает роль/задачи/стиль | profile_update.md |
| Нужно извлечь повторяющиеся задачи | insight_extraction.md |
| Нажал 👍/👌/👎 | feedback.md |
| Недельный отчёт | weekly_review.md |
```

### A4. Conversation scratchpad / audit trail

В ECOM `scratchpad` — это audit trail. Для `time-agent` нужен аналог:

```ts
type ConversationRunAudit = {
  runId: string;
  employeeId: string;
  threadId: string;
  selectedProcesses: string[];
  profileSnapshot: unknown;
  consentSnapshot: unknown;
  inputClassification: string;
  toolsCalled: Array<{
    tool: string;
    payload: unknown;
    result: unknown;
  }>;
  extractedInsights: string[];
  privacyProjection: {
    personalOnly: string[];
    aggregateEligible: string[];
    blocked: string[];
  };
};
```

Это поможет:

- executable specs;
- отладке;
- будущей карте автоматизации;
- объяснимости privacy decisions.

### A5. Privacy ledger вместо refs ledger

В ECOM критичен `refs` ledger. В `time-agent` важнее privacy ledger:

```ts
type PrivacyLedger = {
  personalContext: Array<{
    fact: string;
    sourceMessageId: string;
    canEmployeeSee: true;
  }>;
  aggregateCandidates: Array<{
    signal: string;
    category: string;
    minGroupSizeRequired: 5;
    containsPersonalData: false;
  }>;
  blockedFromAggregation: Array<{
    reason: string;
    dataKind: string;
  }>;
};
```

Сервис должен явно различать:

- что можно сохранить в личный профиль;
- что можно превратить в обезличенный insight;
- что нельзя отдавать компании;
- что нельзя агрегировать вообще.

---

## 4.2. Уровень B — взять после первых сценариев

### B1. Упрощённый Instruction Store

Полный ECOM-формат пока не нужен. Для MVP достаточно:

```text
docs/agent-manual/
  registry.json
  core.md
  processes/
    evening_reflection.md
    morning_planning.md
    consent_and_privacy.md
  metadata/
    evening_reflection.json
```

Пример metadata:

```json
{
  "id": "evening_reflection",
  "version": "0.1.0",
  "dependsOn": [
    "docs/product/agent-minutka-brief.md",
    "docs/plans/time-agent-mastra-plan.md"
  ],
  "owner": "product/methodology",
  "lastReviewed": "2026-07-08"
}
```

### B2. `MinutkaContextBuilder` как Resolver-lite

В `time-agent` уже есть `src/application/minutka-context-builder.ts`. Его можно развить так, чтобы он выбирал process files по сценарию.

Вход:

- user message;
- employee profile;
- consent state;
- thread state;
- scenario classification.

Выход:

```ts
type MinutkaContext = {
  coreInstructions: string;
  selectedProcessIds: string[];
  selectedProcessContent: string;
  profileContext: string;
  memoryContext: string;
  attention: string[];
};
```

### B3. Drift warnings для product docs

Когда меняются:

- `docs/product/agent-minutka-brief.md`;
- `docs/plans/time-agent-mastra-plan.md`;
- privacy/product rules;
- executable specs;

должно быть понятно, какие process-файлы нужно проверить.

Сначала это может быть простой скрипт:

```bash
npm run agent-manual:check
```

Он проверяет:

- все dependencies существуют;
- нет process-файлов без metadata;
- process index ссылается только на существующие файлы;
- изменённые docs подсвечивают affected processes.

### B4. Eval-driven prompt evolution

У нас есть executable specs. Это идеальная основа для Process Architect Lite.

Пример:

- `SPEC-GUARDRAILS-001` упал;
- проблема, вероятно, в `workday_guardrails.md` или `core.md`;
- Process Architect Lite получает failed spec, actual response, selected process files, product constraints;
- предлагает patch;
- человек принимает/редактирует;
- затем `npm run verify`.

---

## 4.3. Уровень C — не брать сейчас

### C1. Полный автономный Process Architect

Для раннего MVP это слишком тяжело.

Не стоит сейчас брать:

- автономную PA-очередь;
- LLM-concurrency;
- conflict rebase;
- автоматическую запись новых версий;
- `world_refresh` / `world_create` в полном виде.

Лучше начать с human-in-loop review.

### C2. Полный fingerprint baseline и relocation map

В ECOM мир может радикально меняться: `/proc/payment-ledger` → `/proc/payments`, схемы БД, docs, tools. Поэтому там нужны `sha256`, relocation map, world baseline.

У нас пока мир — собственный репозиторий и продуктовые документы. Достаточно dependency check. Полные fingerprints понадобятся позже, если появятся:

- много методологических документов;
- client-specific policies;
- разные конфигурации компаний;
- drift между методологией и агентными процессами.

### C3. Claude CLI / Python MCP runtime

`time-agent` построен на Mastra + TypeScript. Перенос Python-оркестратора не нужен.

Стоит взять идеи:

- controlled tool boundary;
- audit logs;
- selected processes;
- task/run artifacts;

но реализовать нативно в TS/Mastra.

---

## 5. Предлагаемая карта процессов для «Минутки»

### `core.md`

Общие правила:

- агент — партнёр для разбора рабочего дня;
- не делает работу за сотрудника;
- не пишет посты/КП/письма;
- не давит, не оценивает, не контролирует;
- компания видит только агрегаты;
- persona меняет тон, но не правила;
- privacy и consent всегда выше запроса пользователя.

### `processes/index.md`

Router:

- onboarding;
- morning planning;
- midday checkin;
- evening reflection;
- guardrails;
- profile update;
- insight extraction;
- feedback;
- weekly review.

### `processes/onboarding.md`

- согласие;
- роль;
- типовые задачи;
- уровень ИИ-грамотности;
- persona;
- подтверждение портрета.

### `processes/consent_and_privacy.md`

- что видит сотрудник;
- что видит компания;
- что нельзя раскрывать;
- min group size ≥5;
- запрет на индивидуальные emotional states в company view.

### `processes/morning_planning.md`

- короткое планирование дня;
- 1–3 приоритета;
- учёт вчерашних незавершённых задач;
- без давления;
- не превращать в таск-менеджер.

### `processes/midday_checkin.md`

- что изменилось;
- нужно ли перепланировать;
- поддержка/структурирование.

### `processes/evening_reflection.md`

- отражение дня;
- что получилось;
- что мешало;
- энергия/стресс;
- планы на завтра;
- candidates for insight extraction.

### `processes/workday_guardrails.md`

- отказ от нерелевантных задач;
- отказ писать рабочие материалы за сотрудника;
- мягкий возврат к разбору рабочего дня;
- если сотрудник просит совет по подходу — можно помочь структурой.

### `processes/profile_update.md`

- когда обновлять профиль;
- какие поля можно менять;
- как подтверждать важные изменения;
- не делать выводы слишком уверенно.

### `processes/insight_extraction.md`

- категории задач;
- повторяемость;
- automation candidates;
- стресс/энергия;
- что personal-only;
- что aggregate-safe.

### `processes/automation_signal.md`

- как превращать insights в агрегаты;
- min group size;
- отсутствие ФИО и конкретных задач;
- уровень уверенности.

### `processes/feedback.md`

- 👍/👌/👎;
- как сохранять;
- как использовать для улучшения стиля;
- не делать драматичных выводов по одному feedback.

### `processes/weekly_review.md`

- обзор недели;
- паттерны;
- бережные рекомендации;
- личный план;
- не управленческая оценка.

---

## 6. Как встроить в текущий `time-agent`

Текущая структура `time-agent` уже подходит:

```text
src/application/
  minutka-context-builder.ts
  minutka-service.ts
  deterministic-insight-extractor.ts
  profile-store.ts
  insight-store.ts

src/mastra/
  agents/minutka-agent.ts
  tools/update-profile-tool.ts
  tools/extract-insights-tool.ts
```

### Шаг 1. Добавить `agent-manual`

```text
docs/agent-manual/
  registry.json
  core.md
  author-contract.md
  processes/*.md
```

### Шаг 2. Добавить loader

```text
src/application/agent-manual-loader.ts
```

Он читает registry и markdown-файлы процессов.

### Шаг 3. Расширить `MinutkaContextBuilder`

Он должен выбирать process files по сценарию:

```ts
if (isFirstConversation(profile)) {
  select("onboarding", "consent_and_privacy");
}

if (looksLikeEveningReflection(message)) {
  select("evening_reflection", "insight_extraction");
}

if (asksToWriteWorkDeliverable(message)) {
  select("workday_guardrails");
}
```

На старте классификация может быть deterministic heuristics, а не LLM.

### Шаг 4. Добавить audit в application layer

В `MinutkaService` сохранять:

- selected processes;
- profile snapshot;
- tools called;
- extracted insights;
- privacy projection.

### Шаг 5. Покрыть executable specs

Новые/усиленные specs:

- onboarding selects onboarding + consent;
- evening reflection selects evening process;
- post-writing request selects guardrails and refuses;
- extracted insight has privacy classification;
- aggregate candidate not emitted if group size <5.

---

## 7. Важные уроки ECOM1 для «Минутки»

### Урок 1. Процессы должны быть минималистичными

В ECOM postmortem явно зафиксировано: в слепых условиях безопаснее использовать минимальный набор жёстких правил, чем перегруженные процессы.

Для «Минутки» это критично. Продукт чувствителен к приватности и тону. Если process-файлы перегрузить, агент станет либо канцелярским, либо начнёт давать лишние обещания.

Правило:

> Один process-файл — один сценарий, 60–150 строк, минимум пересказа, максимум ясных gates.

### Урок 2. Правила безопасности должны быть в core

В ECOM security-правила потерялись в отдельных business processes, поэтому их вынесли в `executor_core`.

Для нас privacy/consent нельзя прятать только в `consent_and_privacy.md`. Базовые запреты должны быть в `core.md`:

- компания не получает личные диалоги;
- не раскрывать индивидуальное эмоциональное состояние;
- min group size ≥5;
- сотрудник может видеть/исправлять свой портрет;
- persona не отменяет приватность.

### Урок 3. Не переобучаться под конкретные specs

Business process должен описывать класс поведения, а не конкретную тестовую фразу.

Неправильно:

> Если пользователь написал «Напиши пост для соцсети», откажи.

Правильно:

> Если пользователь просит создать рабочий deliverable вместо него — мягко откажи и предложи помочь структурировать подход.

### Урок 4. Ссылаться на источник, не пересказывать всё

Из ECOM-уроков:

> Строишь процессы поверх политик мира — ссылайся на источник и минимизируй пересказ.

Для нас process-файлы должны ссылаться на:

- product brief;
- privacy rules;
- Mastra plan;
- executable specs;
- методологические документы.

### Урок 5. Нужна наблюдаемость агентного поведения

ECOM сохраняет:

- rendered prompt;
- selected instruction versions;
- answer;
- result;
- tool calls;
- scratchpad;
- logs;
- PA reports.

Для `time-agent` на MVP достаточно dev/audit артефактов:

```text
conversation_runs/
  run.json
  selected-processes.json
  prompt-preview.md
  tool-calls.json
  insights.json
  privacy-ledger.json
```

---

## 8. Рекомендованный план внедрения

## Phase A — Agent Manual Lite

**Срок:** 1–2 дня.

Deliverables:

- `docs/agent-manual/core.md`
- `docs/agent-manual/author-contract.md`
- `docs/agent-manual/registry.json`
- `docs/agent-manual/processes/index.md`
- первые процессы:
  - `onboarding.md`
  - `consent_and_privacy.md`
  - `evening_reflection.md`
  - `workday_guardrails.md`

Цель: перестать растить один большой prompt.

## Phase B — подключить к `MinutkaContextBuilder`

**Срок:** 1–2 дня.

Deliverables:

- markdown loader;
- deterministic process selection;
- selected process content в agent context;
- specs на выбор процессов.

## Phase C — audit + privacy ledger

**Срок:** 1 день.

Deliverables:

- `ConversationRunAudit`;
- `PrivacyLedger`;
- запись selected processes и emitted insights;
- guardrails specs.

## Phase D — Process Architect Lite

**Срок:** позже, после первых падений specs.

Идея CLI:

```bash
npm run agent-manual:review-failed-spec -- SPEC-GUARDRAILS-001
```

Вход:

- failed spec result;
- actual response;
- selected processes;
- relevant docs.

Выход:

- markdown proposal;
- optional patch;
- человек принимает вручную.

## Phase E — versioning / drift

**Срок:** позже.

Deliverables:

- metadata dependencies;
- hash check;
- warning при изменении docs;
- возможно immutable versions.

---

## 9. Proposed initial file tree

```text
docs/agent-manual/
  README.md
  registry.json
  author-contract.md
  core.md
  processes/
    index.md
    onboarding.md
    consent_and_privacy.md
    evening_reflection.md
    workday_guardrails.md
    insight_extraction.md
    feedback.md
  metadata/
    onboarding.json
    consent_and_privacy.json
    evening_reflection.json
    workday_guardrails.json
    insight_extraction.json
    feedback.json
```

---

## 10. Proposed executable specs

### `SPEC-AGENT-MANUAL-001` — process registry is valid

- Given `docs/agent-manual/registry.json`
- When manual loader reads it
- Then every listed process file exists
- And every metadata dependency exists

### `SPEC-PROCESS-ROUTING-001` — onboarding selects onboarding + privacy

- Given new employee without profile
- When first message arrives
- Then context builder selects `onboarding` and `consent_and_privacy`

### `SPEC-PROCESS-ROUTING-002` — evening reflection selects reflection + insight extraction

- Given employee with profile
- When message describes the day ending
- Then context builder selects `evening_reflection` and `insight_extraction`

### `SPEC-GUARDRAILS-001` — work deliverable request is refused softly

- Given employee asks agent to write a post/proposal/email for them
- When service handles message
- Then agent refuses to do the work directly
- And offers to help structure the approach
- And no work-product insight is extracted

### `SPEC-PRIVACY-LEDGER-001` — personal vs aggregate data is separated

- Given employee shares stress and repeated routine
- When insight extraction runs
- Then personal state is personal-only
- And routine/automation signal is aggregate candidate only if anonymized

---

## 11. Trade-offs

### Why not full Process Architect now

Pros of full PA:

- automatic prompt evolution;
- fast adaptation;
- strong versioning.

Cons for MVP:

- too much infrastructure;
- hard to validate safety;
- risk of autonomous prompt drift;
- increases complexity before product scenarios stabilize.

Decision:

> Start with manual/human-in-loop process evolution via executable specs.

### Why markdown manual first

Pros:

- easy to review with product/methodology team;
- easy to diff;
- easy to cite in specs;
- no migration cost if later converted to versioned store.

Cons:

- weaker runtime guarantees;
- no automatic hash matching;
- possible manual drift.

Decision:

> Markdown manual is enough for prototype. Add dependency checks after first integration.

### Why deterministic routing first

Pros:

- testable;
- cheap;
- predictable;
- avoids another LLM classification step.

Cons:

- may miss subtle scenarios;
- heuristics need maintenance.

Decision:

> Use deterministic routing first, add LLM classifier only if specs show need.

---

## 12. Final recommendation

Из `ecom1-process-architect` для `time-agent` стоит взять **архитектурный подход**, а не тяжёлую реализацию:

1. Оформить агентные инструкции как набор process-файлов.
2. Добавить process index/router.
3. Вынести privacy/security boundaries в `core.md`.
4. Ввести author contract для единообразных процессов.
5. Добавить privacy ledger и selected-process audit.
6. Использовать executable specs как механизм эволюции процессов.
7. Позже добавить Process Architect Lite и dependency/drift checks.

Первое практическое действие:

> Создать `docs/agent-manual/` и перенести базовые правила «Минутки» в маленький manual: `core.md`, `index.md`, `onboarding.md`, `consent_and_privacy.md`, `evening_reflection.md`, `workday_guardrails.md`, `insight_extraction.md`, `feedback.md`.
