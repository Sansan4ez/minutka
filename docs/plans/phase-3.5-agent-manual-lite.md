# Этап 3.5: Agent Manual Lite — бизнес-процессы как код

> **Родительский план:** [time-agent-mastra-plan.md](./time-agent-mastra-plan.md)  
> **Предыдущий этап:** [phase-3-context-guardrails-insights.md](./phase-3-context-guardrails-insights.md)  
> **Стартовый тег:** `phase-3-context-insights`  
> **Целевой тег:** `phase-3.5-agent-manual-lite`

---

## 1. Цель этапа

Оформить поведение `MinutkaAgent` как небольшой, проверяемый и версионируемый через git **Agent Manual**: набор атомарных procedural business-process файлов, которые можно валидировать specs, выбирать file-first constrained LLM-routing-ом и подмешивать в динамический контекст агента.

После Phase 1–3 в проекте уже есть:

- application flow для chat/onboarding;
- профиль, consent и persona;
- `MinutkaContextBuilder` для динамического profile/persona context;
- conversation memory boundary и Mastra Memory runtime bridge;
- deterministic `WorkPolicy` / guardrails;
- `InsightExtractor` boundary и structured insights;
- executable specs `SPEC-SKELETON-001`, `SPEC-ONBOARDING-001`, `SPEC-CONTEXT-001`, `SPEC-GUARDRAILS-001`.

Phase 3.5 должна вынести агентные правила из монолитных инструкций и разрозненных application heuristics в проверяемый manual, но **не должна** строить полноценную Process Architect/versioning/filesystem-runtime инфраструктуру.

Ключевой результат: `MinutkaContextBuilder` становится file-first context builder-ом: он работает с заранее загруженным `docs/agent-manual`, добавляет обязательные application-policy процессы, передаёт `processes/index.md` в constrained LLM-router для выбора optional process ids, возвращает `selectedProcessIds` для audit/specs и добавляет `core.md` + выбранные process-файлы в `systemContext` агента. Manual читается loader-ом на startup / при создании spec harness, а не с диска на каждый chat request.

---

## 2. Definition of Done

- [ ] Создана структура `docs/agent-manual/`:
  - [ ] `README.md`
  - [ ] `registry.json`
  - [ ] `author-contract.md`
  - [ ] `core.md`
  - [ ] `processes/index.md`
  - [ ] `processes/onboarding.md`
  - [ ] `processes/consent_and_privacy.md`
  - [ ] `processes/evening_reflection.md`
  - [ ] `processes/workday_guardrails.md`
  - [ ] `processes/insight_extraction.md`
  - [ ] `processes/feedback.md`
- [ ] Каждый process-файл содержит обязательные секции:
  - `## When this process applies`
  - `## Inputs`
  - `## Process`
  - `## Outputs`
  - `## Privacy notes`
  - `## Anti-patterns`
  - `## Dependencies`
- [ ] `registry.json` содержит machine-readable список процессов, paths, `appliesTo` и dependencies; `processes/index.md` является file-first routing map, а TypeScript resolver только валидирует constrained LLM-router output и добавляет mandatory application-policy processes.
- [ ] `processes/index.md` человекочитаемо описывает процессы и их границы.
- [ ] Product scenarios из `docs/product/Final_Description.md`, `docs/product/virtual-simulation.md`, при необходимости `docs/product/dialogs-for-agent-minutka.md`, переписаны в procedural BP-формат без копирования больших фрагментов.
- [ ] Добавлен application-level Agent Manual loader.
- [ ] Loader валидирует существование файлов, обязательные секции, уникальность process ids, корректность paths и существование dependency paths; loader не перечитывает manual на каждый chat request.
- [ ] `MinutkaContextBuilder` расширен до file-first Agent Manual context builder:
  - [ ] собирает profile/persona context как раньше;
  - [ ] всегда добавляет `core`;
  - [ ] добавляет mandatory processes из application policy (`onboarding`, `workday_guardrails`, `insight_extraction`, `feedback`);
  - [ ] вызывает constrained LLM-router для optional process ids на основе `processes/index.md`, runtime input, policy и recent turns;
  - [ ] валидирует router output: только известные ids, только applicable `appliesTo`, без invented ids;
  - [ ] добавляет релевантные process-файлы;
  - [ ] возвращает `selectedProcessIds`;
  - [ ] возвращает/формирует manual context для agent prompt.
- [ ] `AgentRunContext` содержит `selectedProcessIds` и, при необходимости, `agentManualContext` / расширенный `systemContext`.
- [ ] `ChatResult` или audit/debug metadata содержит `selectedProcessIds` так, чтобы executable specs могли их проверить без чтения приватного prompt целиком.
- [ ] Onboarding first response также использует Agent Manual resolver, как минимум `core`, `onboarding`, `consent_and_privacy`.
- [ ] Guardrail refusal path использует/аудирует `workday_guardrails`, даже если agent runner не вызывается.
- [ ] Добавлена и проходит `SPEC-AGENT-MANUAL-001`.
- [ ] Добавлена и проходит `SPEC-PROCESS-ROUTING-001`.
- [ ] Все предыдущие specs остаются зелёными.
- [ ] `npm run typecheck` проходит.
- [ ] `npm run specs` проходит.
- [ ] `npm run verify` проходит.
- [ ] `nix run .#verify` проходит.
- [ ] Коммит и тег `phase-3.5-agent-manual-lite`.

---

## 3. Границы этапа

### Входит

1. Markdown Agent Manual в `docs/agent-manual`.
2. Author contract для написания business-process файлов.
3. Registry/index для file-first constrained LLM выбора optional процессов.
4. Application-level loader и validator.
5. Расширение `MinutkaContextBuilder` до file-first context builder с constrained LLM-router boundary.
6. Audit/debug exposure `selectedProcessIds`.
7. Executable specs на валидность manual и routing процессов.
8. Документирование виртуального namespace `/AGENTS.md`, `/docs`, `/proc`, `/bin` как контракта.
9. Минимальная синхронизация `MinutkaAgent.instructions` с manual: базовые правила можно оставить как fallback, но source of truth для runtime context должен быть manual.
10. Feedback process как документ и routing target, даже если полноценное сохранение feedback будет реализовано в Phase 4.

### Не входит

- Immutable `units/vNNNN` store.
- Hash-based dependency matching или manifest hashes.
- Process Architect LLM.
- Unconstrained LLM process routing without `processes/index.md`, allow-list validation and executable specs.
- MCP/filesystem runtime.
- Реальные remote endpoints для `/proc` и `/bin`.
- Telegram handlers и feedback buttons — Phase 4.
- Новый persistent storage.
- Полная миграция всех продуктовых сценариев будущих фаз: weekly report, automation map, deletion, methodologist panel можно оставить как future processes.

---

## 4. Архитектурное решение этапа

Сохраняем слойность:

```text
Domain → Application → Server → SDK → CLI / future Telegram
                ↓
         Mastra runtime bridge
```

Agent Manual — это **application/runtime context source**, а не отдельный продуктовый слой и не replacement для domain/application logic.

### 4.1 Chat flow после Phase 3.5

```text
CLI/SDK/future Telegram
  → server.chat(input)
  → MinutkaService.chat(input)
    1. create messageId and timestamp
    2. emit ChatMessageReceived
    3. load profile
    4. load recent turns
    5. evaluate WorkPolicy
    6. MinutkaContextBuilder.build(input, profile, policy, recentTurns)
       → uses preloaded AgentManual
       → adds mandatory application-policy process ids
       → constrained LLM-router reads processes/index.md and selects optional process ids
       → validates selectedProcessIds against registry/appliesTo
       → profile/persona context
       → agentManualContext = core.md + selected process markdown
    7a. if blocked:
          build deterministic refusal response
          emit WorkBoundaryApplied with selectedProcessIds/debug metadata
    7b. if allowed:
          call AgentRunner(input, AgentRunContext)
    8. save message/turn
    9. if policy.shouldExtractInsights: call InsightExtractor
    10. save insights and emit InsightRecorded
    11. return ChatResult with selectedProcessIds
```

### 4.2 Onboarding first response после Phase 3.5

```text
completeOnboarding(input)
  → save profile/participant
  → resolve manual context for purpose = onboarding_first_response
     selected: core + onboarding + consent_and_privacy
  → agentRunner(..., AgentRunContext)
  → return firstResponse
```

В Phase 3.5 **не расширяем** `CompleteOnboardingResult` под `selectedProcessIds`, чтобы не создавать лишний SDK churn для onboarding API. Onboarding process selection проверяется через observed mock runner `AgentRunContext.selectedProcessIds` и/or resolver spec. Публичный `selectedProcessIds` добавляется только в `ChatResult`, где он нужен для executable path chat → SDK → server → service.

---

## 5. Agent Manual структура

Создать:

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
```

### 5.1 `README.md`

Назначение:

- объясняет, что Agent Manual — runtime-инструкции для `MinutkaAgent`, а не продуктовая документация;
- фиксирует принцип business processes as code;
- описывает связь с `docs/product/*`;
- описывает lifecycle изменения manual:
  1. изменить/добавить process-файл;
  2. обновить `registry.json` и `processes/index.md`;
  3. обновить/добавить executable spec;
  4. запустить `npm run verify`;
  5. commit/review через git.

### 5.2 `author-contract.md`

Зафиксировать обязательный contract:

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

Дополнительные правила:

- один файл — один атомарный класс поведения;
- писать procedural instructions, не маркетинговое описание;
- common privacy и product boundary правила не копировать, а ссылаться на `core.md` и `consent_and_privacy.md`;
- `Dependencies` должны указывать существующие файлы в репозитории; это могут быть docs, specs или source contracts, например:
  - `docs/product/Final_Description.md#scenario-1-employee-joins-the-program`
  - `docs/product/virtual-simulation.md#scenario-6-evening-voice-reflection`
  - `docs/plans/time-agent-mastra-plan.md#45-виртуальная-unix-like-среда-агента`
  - `specs/executable/context/SPEC-CONTEXT-001.spec.ts`
- не хранить secrets, PII, реальные Telegram IDs или raw employee transcripts.

### 5.3 `core.md`

Source of truth для базовых правил `MinutkaAgent`:

- роль: AI-партнёр рабочего дня;
- что делает: слушает, отражает, помогает структурировать, замечает паттерны;
- что не делает: не пишет материалы за сотрудника, не делает web research, не обучает ИИ без запроса/готовности, не оценивает, не контролирует;
- privacy baseline;
- persona constraints: persona меняет тон, но не отменяет boundaries;
- virtual namespace contract:

```text
/AGENTS.md  → this manual core + selected processes
/docs       → product docs, plans, policy docs
/proc       → profile, consent, thread context, insights, feedback state
/bin        → allowed application use cases/tools
```

Важно: `/AGENTS.md`, `/docs`, `/proc`, `/bin` в Phase 3.5 — логические ручки, не реальные root-директории и не filesystem runtime.

### 5.4 `registry.json`

Предлагаемый минимальный формат:

```json
{
  "version": 1,
  "manualId": "minutka-agent-manual-lite",
  "core": {
    "id": "core",
    "path": "docs/agent-manual/core.md"
  },
  "processes": [
    {
      "id": "onboarding",
      "path": "docs/agent-manual/processes/onboarding.md",
      "appliesTo": ["onboarding_first_response"],
      "dependencies": [
        "docs/product/Final_Description.md",
        "docs/product/virtual-simulation.md",
        "specs/executable/onboarding/SPEC-ONBOARDING-001.spec.ts"
      ]
    }
  ]
}
```

На Phase 3.5 **не добавляем `routingHints`** в registry. Registry описывает доступные процессы и их dependencies, а routing map живёт в `processes/index.md`. TypeScript-код не содержит растущий набор regex/pattern rules: он добавляет mandatory processes из application policy, вызывает constrained LLM-router для optional процессов и валидирует, что router вернул только известные/applicable ids. Это сохраняет file-first стиль без скрытого JSON DSL.

### 5.5 `processes/index.md`

Человекочитаемый индекс:

| Process id | Когда выбирать | Основные dependencies |
|---|---|---|
| `onboarding` | Первый ответ после заполнения профиля | `SPEC-ONBOARDING-001`, product onboarding scenarios |
| `consent_and_privacy` | Онбординг, privacy questions, любые ответы с privacy boundary | privacy docs/product scenarios |
| `evening_reflection` | Вечерняя рефлексия, сравнение с morning plan, blockers | `SPEC-CONTEXT-001` |
| `workday_guardrails` | Out-of-scope requests, content generation/web research/AI training boundaries | `SPEC-GUARDRAILS-001` |
| `insight_extraction` | Когда `policy.shouldExtractInsights = true` | Phase 3 insights model/specs |
| `feedback` | После ответа агента, быстрые реакции 👍/👌/👎 | future `SPEC-FEEDBACK-001` |

---

## 6. Минимальное содержание process-файлов

### 6.1 `onboarding.md`

Purpose: первый контакт и завершение профиля.

Обязательно описать:

- когда применяется: `purpose = onboarding_first_response`, новый участник, профиль только что заполнен;
- inputs: role, typical tasks, persona, AI level, response length, consent state;
- process:
  1. подтвердить, что профиль принят;
  2. коротко объяснить роль Минутки;
  3. не повторять privacy explanation целиком, если consent уже принят;
  4. обозначить следующий простой шаг — утренний/первый check-in;
  5. применять persona tone;
- outputs: short first response;
- anti-patterns: длинный курс про ИИ, давление, обещания компании показать личные данные, сбор лишней PII;
- dependencies: product onboarding scenarios + `SPEC-ONBOARDING-001`.

### 6.2 `consent_and_privacy.md`

Purpose: privacy boundary.

Обязательно описать:

- компания и методолог не видят личные диалоги, raw transcripts, индивидуальные задачи и эмоциональные состояния;
- aggregated analytics видимы только privacy-safe образом, минимум 5 сотрудников;
- employee controls future: review/correction/deletion будут расширяться позже;
- agent не должен сохранять прямые персональные данные в insights;
- dependencies: `docs/product/Final_Description.md`, `docs/product/virtual-simulation.md`, Phase 2/3 plans.

### 6.3 `evening_reflection.md`

Purpose: вечерняя рефлексия и связь с контекстом дня.

Обязательно описать:

- когда применяется: сообщения про итог дня, «не успел», blockers, звонки/встречи, усталость, сравнение с планом;
- inputs: profile, persona, recentTurns, morning plan, current text, policy decision;
- process:
  1. найти в recent turns утренний план/приоритет;
  2. отразить факт без оценки;
  3. назвать 1–2 паттерна осторожным языком;
  4. предложить маленький следующий шаг на завтра;
  5. не делать performance judgement;
- outputs: concise reflection response, possible insight extraction trigger;
- dependencies: `SPEC-CONTEXT-001`, product evening reflection scenario.

### 6.4 `workday_guardrails.md`

Purpose: границы тематики и роли.

Обязательно описать:

- когда применяется: content generation request, web research, AI training request вне готовности/контекста, нерелевантные темы;
- process:
  1. определить boundary reason;
  2. мягко отказаться;
  3. вернуть разговор к рабочему дню: приоритеты, blockers, следующий шаг;
  4. не извлекать insights из out-of-scope запроса;
- outputs: refusal response; `shouldExtractInsights = false`;
- anti-patterns: всё равно написать пост/письмо/КП, спорить с пользователем, стыдить;
- dependencies: `SPEC-GUARDRAILS-001`, product scenario “in-the-moment help”.

### 6.5 `insight_extraction.md`

Purpose: правила создания structured insights.

Обязательно описать:

- applies only when `policy.shouldExtractInsights = true`;
- kinds: `task_category`, `routine_pattern`, `energy_stress_marker`, `automation_candidate`;
- не хранить raw transcript, ФИО, Telegram ID, email, phone, внешние IDs;
- labels/rationale должны быть короткими нормализованными рабочими сигналами;
- source связывать через `sourceMessageId` / `threadId`;
- dependencies: `src/domain/insights.ts`, `SPEC-CONTEXT-001`, Phase 3 plan.

### 6.6 `feedback.md`

Purpose: подготовка Phase 4 feedback flow.

Обязательно описать:

- когда применяется: пользователь оценивает ответ 👍/👌/👎;
- inputs: employeeId, threadId, response/message id, rating, timestamp;
- process:
  1. сохранить feedback как реакцию на конкретный ответ;
  2. не просить объяснение обязательно;
  3. использовать как сигнал качества, не как оценку сотрудника;
  4. не раскрывать feedback компании как индивидуальную запись;
- outputs: saved feedback event/result, short acknowledgement if needed;
- dependencies: future `SPEC-FEEDBACK-001`, Phase 4 section in parent plan.

---

## 7. Application design

### 7.1 Новые файлы

Предлагаемые файлы:

```text
src/application/agent-manual-loader.ts
src/application/agent-manual-types.ts
src/application/agent-manual-resolver.ts
```

Если хочется минимальнее, можно объединить types + loader в один файл, но не смешивать с `MinutkaService`. Предпочтение Phase 3.5 — простые pure functions и plain objects; class/caching abstraction добавлять только если это реально уменьшает код.

### 7.2 Domain/Application types

Минимальные типы:

```ts
export type AgentManualProcessId =
  | "core"
  | "onboarding"
  | "consent_and_privacy"
  | "evening_reflection"
  | "workday_guardrails"
  | "insight_extraction"
  | "feedback";

export type AgentManualProcess = {
  id: Exclude<AgentManualProcessId, "core">;
  path: string;
  content: string;
  appliesTo?: string[];
  dependencies: string[];
};

export type AgentManual = {
  version: number;
  manualId: string;
  core: { id: "core"; path: string; content: string };
  processes: AgentManualProcess[];
};

export type AgentManualSelection = {
  selectedProcessIds: AgentManualProcessId[];
  manualContext: string;
};
```

### 7.3 Loader contract

```ts
export type AgentManualLoader = {
  load(): AgentManual;
  validate?(manual: AgentManual): AgentManualValidationResult;
};
```

Для Phase 3.5 предпочтительно сделать loader синхронным и использовать его на startup / при создании service или spec harness: `loadAgentManualFromDisk()` читает файлы один раз, validator падает диагностичной ошибкой, resolver дальше работает с уже загруженным `AgentManual`. Не нужно протаскивать async filesystem calls через весь chat path.

Loader должен:

1. читать `docs/agent-manual/registry.json`;
2. читать `core.md` и process-файлы;
3. проверять уникальность ids;
4. проверять существование path;
5. проверять обязательные Markdown секции;
6. проверять dependencies:
   - path до `#anchor` должен существовать как файл;
   - для `specs/...` должен существовать файл;
7. возвращать понятные ошибки validation spec-у.

### 7.4 Context builder / constrained router

Текущий `buildMinutkaProfileContext(profile)` оставить как building block, но добавить новый API:

```ts
export type BuildMinutkaContextInput = {
  purpose: "chat" | "onboarding_first_response" | "feedback";
  text?: string;
  profile?: UserProfile;
  policy?: WorkPolicyDecision;
  recentTurns?: ConversationTurn[];
};

export type BuiltMinutkaContext = {
  systemContext: string;
  selectedProcessIds: AgentManualProcessId[];
};
```

Предлагаемая функция:

```ts
export async function buildMinutkaContext(
  input: BuildMinutkaContextInput,
  deps?: { manual?: AgentManual; router?: AgentManualRouter },
): Promise<BuiltMinutkaContext>;
```

`manual` лучше загрузить один раз при создании service/harness и передать в `MinutkaServiceDeps`. `router` — async boundary, который в runtime реализован LLM-router-ом, а в specs заменяется mock-router-ом. Если manual не передан, builder должен уметь работать в backward-compatible fallback режиме: вернуть profile-only `systemContext` и пустой `selectedProcessIds`. Это позволяет поэтапно интегрировать manual без зависимости executable specs от внешнего LLM/API.

### 7.5 Routing rules для Phase 3.5

Routing делится на mandatory и optional selection.

Mandatory selection остаётся в application code, потому что это hard policy / lifecycle state, а не semantic interpretation:

1. Всегда выбирать `core`, если manual доступен.
2. Если `purpose = onboarding_first_response`:
   - `onboarding`
   - `consent_and_privacy`
3. Если `policy.allowedForAgent = false`:
   - `workday_guardrails`
4. Если `purpose = chat` и `policy.shouldExtractInsights = true`:
   - `insight_extraction`
5. Если `purpose = feedback`:
   - `feedback`

Optional selection делает constrained LLM-router:

1. Получает `processes/index.md`, candidate process ids, current text, purpose, `WorkPolicyDecision`, profile и recent turns.
2. Выбирает только ids из allow-list candidate ids.
3. Возвращает строгий JSON `{ "selectedProcessIds": [...] }` без объяснений.
4. TypeScript resolver фильтрует output: unknown ids, ids вне `appliesTo`, duplicate ids и invented ids отбрасываются.
5. При ошибке router-а используется safe fallback: только mandatory process ids.

Router должен выбирать по смыслу и не зависеть от языка запроса. Это сознательно заменяет накопление regex/pattern heuristics, которые быстро начинают пересекаться и плохо масштабируются на multilingual input.

### 7.6 AgentRunContext changes

Расширить:

```ts
export type AgentRunContext = {
  profile?: UserProfile;
  systemContext?: string;
  purpose: "chat" | "onboarding_first_response";
  memory?: AgentMemoryContext;
  policy?: WorkPolicyDecision;
  selectedProcessIds?: AgentManualProcessId[];
};
```

`runMinutkaAgent` продолжает передавать `system: context?.systemContext`. Mastra API менять не требуется.

### 7.7 ChatResult / API/SDK contract

Предпочтительный вариант:

```ts
export type ChatResult = {
  messageId: string;
  response: string;
  selectedProcessIds: AgentManualProcessId[];
};
```

Плюсы:

- specs могут проверить routing через публичный executable path CLI → SDK → Server → Service;
- Phase 4 Telegram handlers смогут логировать/audit-ить process selection;
- не нужно раскрывать полный prompt.

Минус: надо обновить SDK Zod schema и существующие specs expected shape. Важно: текущий SDK использует `z.strictObject`, поэтому добавление поля в service response без одновременного обновления `chatResponse` schema сломает executable specs. В Step 8 обязательно обновить strict Zod schema, экспортируемые типы и любые specs/fixtures, где проверяется старый shape.

Альтернатива: добавить `debug`/`audit` поле:

```ts
processAudit: { selectedProcessIds: AgentManualProcessId[] }
```

Но для MVP проще прямое поле.

---

## 8. Virtual Unix-like namespace contract

В Phase 3.5 нужно зафиксировать namespace в docs, но не реализовывать отдельный runtime.

### 8.1 Mapping

| Handle | Phase 3.5 implementation | Notes |
|---|---|---|
| `/AGENTS.md` | `docs/agent-manual/core.md` + selected process files | prompt/context source |
| `/docs` | `docs/product/*`, `docs/plans/*`, `docs/agent-manual/*` | requirements and policies |
| `/proc` | application state: profile, consent, recent turns, policy, insights | not a filesystem |
| `/bin` | typed use cases/tools: chat, profile update, insight extraction, future feedback | not shell commands |

### 8.2 Правила

- Telegram/CLI handlers не должны напрямую выбирать process files — routing живёт в Application/ContextBuilder.
- Agent Manual не должен читать storage самостоятельно.
- `/proc` materialization для prompt — только через sanitized context builder.
- `/bin` operations — только typed application services/tools, не произвольные shell commands.

---

## 9. Executable specs

### 9.1 `SPEC-AGENT-MANUAL-001` — agent manual валиден

Файл:

```text
specs/executable/agent-manual/SPEC-AGENT-MANUAL-001.spec.ts
```

Metadata:

- `requirements`: `FR-AGENT-MANUAL-001`, `FR-PROCESS-CONTRACT-001`, `FR-PRIVACY-BOUNDARY-001`
- `productParts`: `ai-agent-backend-runtime`, `data-storage-and-privacy-layer`
- `contracts`: `agentManualLoader`
- `docs`: `docs/agent-manual/registry.json`, `docs/agent-manual/core.md`

Scenario:

```gherkin
Given docs/agent-manual/registry.json, core.md and process files
When manual loader reads Agent Manual
Then every registered path exists
And every process has required author-contract sections
And every process id is unique
And dependencies point to existing repository files
And process index does not reference missing process ids
And core.md documents /AGENTS.md /docs /proc /bin namespace
```

Checks:

- `registry.version === 1`;
- `manualId` exists;
- core path exists;
- at least 6 process files excluding core;
- required process ids present:
  - `onboarding`
  - `consent_and_privacy`
  - `evening_reflection`
  - `workday_guardrails`
  - `insight_extraction`
  - `feedback`
- Markdown section headings exact match;
- dependency file exists before optional `#anchor` and may live under `docs/`, `specs/`, or `src/`;
- `processes/index.md` includes all registered ids;
- no process content contains obvious placeholder markers like `TODO`, `TBD`, `lorem ipsum`;
- soft check / warning: process file longer than ~200 lines should be considered for split, but this warning should not fail Phase 3.5 specs unless content is clearly invalid.

### 9.2 `SPEC-PROCESS-ROUTING-001` — context выбирает правильные процессы

Файл:

```text
specs/executable/agent-manual/SPEC-PROCESS-ROUTING-001.spec.ts
```

Metadata:

- `requirements`: `FR-PROCESS-ROUTING-001`, `FR-CONTEXT-001`, `FR-GUARDRAILS-001`
- `contracts`: `chat`, `completeOnboarding`, `contextBuilder`
- `productParts`: `ai-agent-backend-runtime`

Scenarios:

#### Case A — onboarding

```gherkin
Given employee completed profile and consent
When completeOnboarding builds first agent response context
Then selectedProcessIds include core, onboarding, consent_and_privacy
```

Проверка может быть через observed mock runner `context.selectedProcessIds`.

#### Case B — evening reflection

```gherkin
Given employee has a morning plan in same thread
When employee writes evening reflection: "Отчёт не успел, весь день на звонках"
Then selectedProcessIds include core, evening_reflection, insight_extraction
And response audit/result exposes selectedProcessIds
```

#### Case C — guardrails

```gherkin
Given employee has profile
When employee asks: "Напиши мне пост для соцсети"
Then selectedProcessIds include core, workday_guardrails
And selectedProcessIds do not include insight_extraction
And no insight is recorded
```

#### Case D — feedback prepared

```gherkin
Given feedback routing input or resolver purpose = feedback
When context builder resolves processes
Then selectedProcessIds include core, feedback
```

Если application feedback use case ещё отсутствует, Case D можно проверить напрямую через resolver API, не через CLI.

---

## 10. Implementation plan

### Step 0 — Проверить baseline

Команды:

```bash
npm run typecheck
npm run specs
npm run verify
```

Ожидаемо: все Phase 1–3 specs зелёные до изменений.

### Step 1 — Создать Agent Manual docs

1. Создать `docs/agent-manual/README.md`.
2. Создать `docs/agent-manual/author-contract.md`.
3. Создать `docs/agent-manual/core.md`.
4. Создать `docs/agent-manual/processes/*.md`.
5. Создать `docs/agent-manual/processes/index.md`.
6. Создать `docs/agent-manual/registry.json`.

Проверить вручную:

```bash
find docs/agent-manual -maxdepth 3 -type f | sort
```

### Step 2 — Добавить loader и validation logic

1. Добавить `src/application/agent-manual-types.ts`.
2. Добавить `src/application/agent-manual-loader.ts`.
3. Реализовать:
   - sync JSON parse registry на startup / в harness;
   - path resolution от repo root/current working directory;
   - markdown required-section validation;
   - dependency file validation;
   - index consistency helper.
4. Ошибки сделать диагностичными:
   - `missing process file: ...`
   - `process onboarding missing section: ## Outputs`
   - `dependency does not exist: ...`

Важно: не тянуть runtime dependencies. Использовать Node `fs`, `path` или `node:fs`, `node:path`; не добавлять watcher/runtime reload на Phase 3.5.

### Step 3 — Написать `SPEC-AGENT-MANUAL-001` красным/зелёным

1. Создать `specs/executable/agent-manual/SPEC-AGENT-MANUAL-001.spec.ts`.
2. Использовать loader из application layer.
3. Проверить registry, required sections, dependencies, index.
4. Запустить:

```bash
npm run specs -- specs/executable/agent-manual/SPEC-AGENT-MANUAL-001.spec.ts
```

Если npm script не принимает passthrough как ожидается, использовать:

```bash
npx vitest run specs/executable/agent-manual/SPEC-AGENT-MANUAL-001.spec.ts
```

### Step 4 — Добавить constrained router

1. Добавить `src/application/agent-manual-resolver.ts`.
2. Вынести/расширить `minutka-context-builder.ts`:
   - сохранить `buildMinutkaProfileContext(profile)` для совместимости;
   - добавить `buildMinutkaContext(...)` или class `MinutkaContextBuilder`.
3. Убедиться, что результирующий `systemContext` содержит секции в стабильном порядке, где Agent Manual/core идёт раньше профиля, чтобы базовые boundaries имели больший приоритет:

```text
# Minutka runtime context

## Agent Manual: core
<core.md>

## Agent Manual process: onboarding
<process markdown>

## Profile context
...
```

4. Дедуплицировать process ids: `core` не должен повторяться.
5. Ограничить routing constrained LLM-router-ом: index-first prompt, allow-list ids, JSON-only output, TypeScript validation и safe fallback на mandatory processes.

### Step 5 — Интегрировать resolver в `MinutkaService`

1. Расширить `MinutkaServiceDeps`:

```ts
contextBuilder?: MinutkaContextBuilderLike
```

или передать `agentManualResolver`.

2. В `completeOnboarding()` заменить:

```ts
const systemContext = buildMinutkaProfileContext(profile);
```

на build full context для `purpose: "onboarding_first_response"`.

3. В `chat()` вызвать context builder после policy evaluation и до agent runner/refusal.

4. В allowed path передать:

```ts
{
  profile,
  systemContext: built.systemContext,
  selectedProcessIds: built.selectedProcessIds,
  purpose: "chat",
  memory,
  policy,
}
```

5. В blocked path сохранить/вернуть selected ids, даже если runner не вызывается.

6. Расширить `ChatResult` и SDK schema. Так как SDK response schema strict, это должно быть сделано в том же изменении, где service начинает возвращать `selectedProcessIds`.

### Step 6 — Обновить runtime Mastra agent instructions

Цель: избежать конфликта между hardcoded instructions и manual.

Минимальный безопасный вариант:

- оставить `src/mastra/agents/minutka-agent.ts` с кратким fallback:
  - “Ты Минутка… следуй system context / Agent Manual в runtime instructions”;
  - сохранить запреты как safety fallback, но не раздувать;
- основные подробные правила теперь в `docs/agent-manual/core.md`.

Не нужно на Phase 3.5 читать manual внутри `minutka-agent.ts`: manual должен приходить через `system` от application context builder.

### Step 7 — Написать `SPEC-PROCESS-ROUTING-001`

1. Создать `specs/executable/agent-manual/SPEC-PROCESS-ROUTING-001.spec.ts`.
2. Использовать существующий spec harness и mock agent runner.
3. Проверить onboarding selected ids через observed `AgentRunContext`.
4. Проверить evening reflection selected ids через CLI chat result и/or observed context.
5. Проверить guardrail selected ids через CLI chat result, так как runner не вызывается.
6. Проверить feedback route напрямую через resolver, если feedback use case ещё не реализован.

### Step 8 — Обновить существующие specs/schemas под `selectedProcessIds`

1. `src/client/sdk/minutka-client.ts`:
   - добавить Zod enum/list для process ids;
   - расширить `chatResponse`.
2. Не расширять `completeOnboardingResponse` на Phase 3.5; onboarding selection проверять через observed `AgentRunContext.selectedProcessIds`.
3. Обновить tests, где strict equality ожидает старый shape.
4. Обновить `SPEC-SKELETON-001`, `SPEC-CONTEXT-001`, `SPEC-GUARDRAILS-001`, если они проходят через SDK strict `chatResponse` или проверяют старый shape.
5. Убедиться, что `SPEC-CONTEXT-001` и `SPEC-GUARDRAILS-001` остаются зелёными.

### Step 9 — Проверки

Команды:

```bash
npm run typecheck
npm run specs
npm run verify
nix run .#verify
```

### Step 10 — Документировать завершение

1. Обновить `docs/plans/time-agent-mastra-plan.md`:
   - добавить ссылку на этот подробный план в header;
   - поменять статус Phase 3.5 на ✅ после реализации;
   - указать тег.
2. Коммит:

```bash
git status
git add docs/agent-manual specs/executable/agent-manual src docs/plans
git commit -m "Implement phase 3.5 agent manual lite"
git tag phase-3.5-agent-manual-lite
```

---

## 11. Файлы, которые вероятно будут изменены

### Docs

```text
docs/plans/time-agent-mastra-plan.md
docs/agent-manual/README.md
docs/agent-manual/registry.json
docs/agent-manual/author-contract.md
docs/agent-manual/core.md
docs/agent-manual/processes/index.md
docs/agent-manual/processes/onboarding.md
docs/agent-manual/processes/consent_and_privacy.md
docs/agent-manual/processes/evening_reflection.md
docs/agent-manual/processes/workday_guardrails.md
docs/agent-manual/processes/insight_extraction.md
docs/agent-manual/processes/feedback.md
```

### Source

```text
src/application/agent-manual-types.ts
src/application/agent-manual-loader.ts
src/application/agent-manual-resolver.ts
src/application/minutka-context-builder.ts
src/application/minutka-service.ts
src/client/sdk/minutka-client.ts
src/server/http/in-process-server.ts
src/client/cli/minutka-cli.ts
src/mastra/agents/minutka-agent.ts
```

CLI может не потребовать изменений, если он просто печатает JSON результата `chat`. Если CLI форматирует поля вручную, добавить `selectedProcessIds` в JSON output.

### Specs

```text
specs/executable/agent-manual/SPEC-AGENT-MANUAL-001.spec.ts
specs/executable/agent-manual/SPEC-PROCESS-ROUTING-001.spec.ts
specs/executable/context/SPEC-CONTEXT-001.spec.ts
specs/executable/guardrails/SPEC-GUARDRAILS-001.spec.ts
specs/executable/onboarding/SPEC-ONBOARDING-001.spec.ts
```

Существующие specs менять только если API shape стал шире или появились новые metadata checks.

---

## 12. Риски и решения

| Риск | Решение |
|---|---|
| Manual станет ещё одним неиспользуемым docs-разделом | Обязательно подключить resolver к `MinutkaContextBuilder` и проверять `selectedProcessIds` executable spec-ами. |
| Process-файлы станут длинными marketing docs | Author contract + validation sections + лимит ориентировочно 60–150 строк. |
| Product scenarios будут скопированы целиком | Переписывать в procedural steps, а product docs указывать в `Dependencies`. |
| Routing станет слишком умным и хрупким | Не использовать свободный classifier. Использовать constrained LLM-router: `processes/index.md` как source of truth, allow-list candidate ids, JSON-only output, validation в TypeScript, safe fallback на mandatory processes. |
| Hardcoded `MinutkaAgent.instructions` конфликтуют с manual | Сжать instructions до fallback и приоритета runtime system context. |
| `selectedProcessIds` раскрывает лишнее пользователю | В specs/API можно считать это audit/debug metadata. Для Telegram Phase 4 не показывать пользователю, только логировать/использовать internally. |
| Loader зависит от current working directory | Явно resolve paths от repo root; в specs запускать из root; при необходимости искать root по `package.json`. |
| Agent Manual временно не сконфигурирован в части specs/harness | Builder должен иметь backward-compatible fallback: profile-only context и пустой/minimal process audit до полной интеграции Step 5. |
| `systemContext` разрастётся из-за core + нескольких process-файлов | Держать process-файлы короткими, предупреждать о файлах >~200 строк, в routing выбирать только релевантные процессы; при необходимости добавить size assertion позже. |
| Dependency anchor validation усложнит этап | На Phase 3.5 проверять существование файла до `#anchor`; точные anchors можно оставить на будущую доработку. |
| Feedback process есть, use case ещё нет | Документировать process и проверить resolver purpose `feedback`; реализация сохранения feedback — Phase 4. |

---

## 13. Acceptance checklist для ревью

Перед закрытием этапа ревьюер должен увидеть:

1. `docs/agent-manual` существует и читается как самостоятельный manual.
2. В `core.md` явно описаны границы роли Минутки и virtual namespace.
3. Все process-файлы имеют одинаковый author contract.
4. `registry.json` не расходится с `processes/index.md`.
5. Loader падает с понятной ошибкой при сломанном process-файле.
6. `MinutkaService.chat()` получает context не из старого profile-only builder, а из file-first context builder с constrained router.
7. Mock agent runner в specs видит `context.selectedProcessIds`.
8. Guardrail path возвращает/audit-ит selected processes даже без agent call.
9. Existing Phase 3 behavior сохранён: morning → evening context и no insight для post request.
10. `nix run .#verify` зелёный.

---

## 14. Рекомендуемый порядок коммитов внутри этапа

Если этап хочется разбить на несколько маленьких коммитов:

1. `Add agent manual documentation skeleton`
   - только `docs/agent-manual/*`.
2. `Add agent manual loader and validation spec`
   - loader + `SPEC-AGENT-MANUAL-001`.
3. `Wire process resolver into Minutka context`
   - resolver/context builder/service/API schema.
4. `Add process routing executable spec`
   - `SPEC-PROCESS-ROUTING-001` + fixes.
5. `Finalize phase 3.5 plan status`
   - обновление родительского плана после зелёного verify.

Финальный tag после всех коммитов:

```bash
git tag phase-3.5-agent-manual-lite
```
