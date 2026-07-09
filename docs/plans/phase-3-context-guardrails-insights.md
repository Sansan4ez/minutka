# Этап 3: Контекст, guardrails и извлечение инсайтов — подробный план

> **Статус:** исторический план Phase 3. Deterministic `WorkPolicy`/keyword extractor, описанные ниже как MVP-шаг, superseded после Phase 3.5: текущая архитектура использует SO-CoT constrained conversation decision router и business-process markdown files для `workday_guardrails` и `insight_extraction`.  
> **Родительский план:** [time-agent-mastra-plan.md](./time-agent-mastra-plan.md)  
> **Предыдущий этап:** [phase-2-onboarding-consent-profile.md](./phase-2-onboarding-consent-profile.md)  
> **Стартовый тег:** `phase-2-onboarding`  
> **Целевой тег:** `phase-3-context-insights`

---

## 1. Цель этапа

Сделать минимальный, проверяемый контур рабочего контекста и структурированных сигналов:

- сотрудник утром фиксирует план/приоритет дня;
- вечером пишет рефлексию в том же `threadId`;
- application layer передаёт агенту контекст предыдущих сообщений через memory boundary;
- runtime-bridge Mastra использует `resourceId` + `threadId` для Mastra Memory;
- агент отвечает с учётом утреннего плана;
- out-of-scope запросы мягко отклоняются до insight extraction;
- из релевантных рабочих сообщений сохраняются privacy-safe structured insights:
  - категории задач;
  - рутинные/мешающие паттерны;
  - маркеры энергии/нагрузки/стресса;
  - кандидаты на автоматизацию;
- всё проверяется executable specs без реального LLM/API.

Этап не делает Telegram shell, voice, feedback, агрегационную карту автоматизации и полноценную production-БД. Он добавляет доменные типы, storage boundaries, policy/guardrail слой, extractor boundary, Mastra Memory integration и два ключевых executable specs.

---

## 2. Definition of Done

- [ ] Добавлена и проходит `SPEC-CONTEXT-001`.
- [ ] Добавлена и проходит `SPEC-GUARDRAILS-001`.
- [ ] `SPEC-SKELETON-001` и `SPEC-ONBOARDING-001` остаются зелёными.
- [ ] Domain содержит типы structured insights: task category, routine pattern, energy/stress marker, automation candidate.
- [ ] Domain содержит policy/guardrail decision для рабочей тематики.
- [ ] `InMemoryWorld` расширен безопасно: `insights`, при необходимости `policyDecisions` / `guardrailEvents`, без ломки старых specs.
- [ ] Application service загружает recent thread context перед вызовом `AgentRunner`.
- [ ] `AgentRunContext` содержит memory context: `resourceId`, `threadId`, recent turns для deterministic specs.
- [ ] Runtime `runMinutkaAgent` передаёт в `minutkaAgent.generate()` Mastra `memory: { resource, thread }`.
- [ ] `MinutkaAgent` сконфигурирован с Mastra `Memory` установленной версии.
- [ ] Specs не зависят от реального Mastra Memory, OpenAI key, сети или LLM.
- [ ] Реализован deterministic `WorkPolicy` / guardrail слой для MVP-запретов.
- [ ] Out-of-scope запрос `Напиши мне пост для соцсети` возвращает мягкий отказ и не создаёт insight.
- [ ] Реализован `InsightExtractor` boundary и deterministic extractor для specs/MVP.
- [ ] Добавлен `extractInsightsTool` как Mastra primitive; tool импортируется без ошибок и не ломает smoke.
- [ ] Insight extraction выполняется только после policy decision `shouldExtractInsights = true`.
- [ ] Structured insights не содержат ФИО, Telegram ID, raw transcript, полный текст сообщения или другие прямые персональные данные.
- [ ] Добавлены API/SDK/CLI methods для просмотра insights, если это нужно executable specs и отладки.
- [ ] `npm run typecheck` проходит.
- [ ] `npm run specs` проходит.
- [ ] `npm run verify` проходит.
- [ ] `nix run .#verify` проходит.
- [ ] Коммит и тег `phase-3-context-insights`.

---

## 3. Проверенные Mastra-документы и решения

Перед реализацией кода этапа обязательно ещё раз свериться с embedded docs установленной версии. На момент подготовки плана релевантны:

- `node_modules/@mastra/core/dist/docs/references/reference-agents-generate.md`
- `node_modules/@mastra/core/dist/docs/references/docs-memory-overview.md`
- `node_modules/@mastra/core/dist/docs/references/reference-memory-memory-class.md`
- `node_modules/@mastra/core/dist/docs/references/docs-memory-working-memory.md`
- `node_modules/@mastra/core/dist/docs/references/docs-agents-using-tools.md`
- `node_modules/@mastra/core/dist/docs/references/reference-tools-create-tool.md`

Выводы для Phase 3:

1. `Agent.generate()` поддерживает:
   - `options.system` / `options.instructions` для динамического контекста;
   - `options.memory.resource` и `options.memory.thread` для multi-user/thread memory;
   - `options.context`, но для текущей архитектуры достаточно `system` + `memory`.
2. Mastra Memory подключается через пакет `@mastra/memory` и `new Memory({ options: { lastMessages: ... } })` в `Agent`.
3. Вызов агента должен использовать privacy-safe `resource`, то есть `employeeId`, а не Telegram ID/ФИО.
4. `thread` должен быть стабильным `threadId` из `ChatInput`.
5. `createTool()` используется из `@mastra/core/tools`; `execute` получает валидированный input первым аргументом.
6. `ModerationProcessor` решает safety moderation, но продуктовые границы «не писать посты/письма/КП» лучше реализовать deterministic application policy, чтобы specs были стабильными и не требовали отдельного LLM.

### Dependency decision

Текущий `package.json` после Phase 2 не содержит `@mastra/memory`. На Phase 3 добавить:

```bash
npm install @mastra/memory
```

Если при реализации установленная версия Mastra потребует явный storage provider для стабильного runtime-smoke, добавить отдельным осознанным изменением:

```bash
npm install @mastra/libsql
```

Но executable specs не должны зависеть от SQLite/libSQL-файла и должны проходить через in-memory application boundaries.

---

## 4. Границы этапа

### Входит

1. Mastra Memory integration для `resourceId` + `threadId`.
2. Application-level conversation context boundary для deterministic specs.
3. Расширение `AgentRunContext` контекстом памяти и policy decision.
4. Domain model для insights.
5. In-memory insight store.
6. Deterministic insight extractor boundary.
7. Mastra `extractInsightsTool` как importable primitive.
8. Guardrail/policy слой перед agent/tool extraction.
9. Мягкий отказ на out-of-scope запросы.
10. `SPEC-CONTEXT-001`.
11. `SPEC-GUARDRAILS-001`.
12. CLI/SDK/API для просмотра insights, если это упрощает specs и ручную отладку.

### Не входит

- Реальный Telegram бот — Phase 4.
- Feedback buttons — Phase 4.
- Voice/STT — Phase 5.
- Aggregated automation map / Markdown report — Phase 6.
- Semantic recall/vector DB/embeddings.
- Observational memory.
- Working memory schema для долгосрочного профиля.
- Production PostgreSQL.
- Полноценная content safety moderation.
- Админ-панель методолога.
- Реальный LLM в specs.

---

## 5. Архитектурное решение этапа

Сохраняем слои:

```text
Domain → Application → Server → SDK → CLI / future Telegram
                ↓
         Mastra runtime bridge
```

Ключевое решение: **Phase 3 проверяет контекст и insights через deterministic application boundaries, а Mastra Memory подключает как runtime capability и smoke-import**.

Причины:

- LLM memory retrieval нестабилен для executable specs.
- Specs должны проходить без API keys.
- Product policy и privacy правила нельзя оставлять на усмотрение модели.
- Telegram Phase 4 сможет использовать тот же `chat()` use case.
- В будущем можно заменить in-memory adapters на SQLite/PostgreSQL без изменения SDK/CLI контрактов.

### 5.1 Chat flow после Phase 3

```text
CLI/SDK/Telegram
  → server.chat(input)
  → MinutkaService.chat(input)
    1. создать messageId и timestamp
    2. emit ChatMessageReceived
    3. load profile
    4. load recent turns by employeeId + threadId
    5. evaluate WorkPolicy
    6a. if blocked: build deterministic refusal response
    6b. if allowed: call AgentRunner(input, AgentRunContext)
    7. save ChatMessage / turn
    8. emit ChatResponseGenerated
    9. if policy.shouldExtractInsights: call InsightExtractor
    10. save structured insights
    11. emit InsightRecorded events
    12. return ChatResult
```

### 5.2 Где живёт ответственность

| Responsibility | Layer/file |
|---|---|
| Privacy-safe domain insight types | `src/domain/insights.ts` |
| Policy decision shape | `src/domain/work-policy.ts` или `src/domain/policy.ts` |
| Deterministic guardrail rules | `src/application/work-policy.ts` |
| Conversation recent turns | `src/application/conversation-memory-store.ts` |
| In-memory conversation adapter | поверх `InMemoryWorld.messages` |
| Insight extraction boundary | `src/application/insight-extractor.ts` |
| Deterministic extractor | `src/application/deterministic-insight-extractor.ts` |
| Insight persistence boundary | `src/application/insight-store.ts` |
| In-memory insight adapter | `src/application/in-memory-insight-store.ts` |
| Mastra Memory config | `src/mastra/memory.ts` |
| Runtime memory call | `src/mastra/agent-runner.ts` |
| Mastra insight tool | `src/mastra/tools/extract-insights-tool.ts` |

---

## 6. Доменная модель insights

### 6.1 Новый файл

`src/domain/insights.ts`

### 6.2 Базовые типы

```ts
export type InsightKind =
  | "task_category"
  | "routine_pattern"
  | "energy_stress_marker"
  | "automation_candidate";

export type InsightConfidence = "low" | "medium" | "high";

export type TaskCategory =
  | "planning"
  | "reporting"
  | "meetings"
  | "coordination"
  | "communication"
  | "admin"
  | "focus_work"
  | "unknown";

export type RoutinePatternType =
  | "meeting_overload"
  | "context_switching"
  | "manual_reporting"
  | "coordination_overhead"
  | "waiting_for_input"
  | "unclear_priority"
  | "other";

export type EnergyStressMarkerType =
  | "overload"
  | "fatigue"
  | "frustration"
  | "focus_loss"
  | "blocked_progress"
  | "neutral";

export type AutomationCandidateType =
  | "report_generation"
  | "meeting_reduction"
  | "async_status_update"
  | "task_routing"
  | "template_or_checklist"
  | "data_entry_reduction"
  | "other";
```

### 6.3 Structured insight shape

Не хранить raw transcript внутри insight. Источник — через `sourceMessageId` / `sourceThreadId`.

```ts
export type InsightBase = {
  id: string;
  employeeId: string;       // privacy-safe pseudonym
  threadId: string;
  sourceMessageId: string;
  kind: InsightKind;
  label: string;            // normalized short label, e.g. "звонки", not full text
  confidence: InsightConfidence;
  createdAt: string;
};

export type TaskCategoryInsight = InsightBase & {
  kind: "task_category";
  category: TaskCategory;
};

export type RoutinePatternInsight = InsightBase & {
  kind: "routine_pattern";
  patternType: RoutinePatternType;
  interferesWith?: string;  // normalized short label, e.g. "квартальный отчёт"
};

export type EnergyStressInsight = InsightBase & {
  kind: "energy_stress_marker";
  marker: EnergyStressMarkerType;
  intensity: "low" | "medium" | "high";
};

export type AutomationCandidateInsight = InsightBase & {
  kind: "automation_candidate";
  candidateType: AutomationCandidateType;
  rationale: string;        // short normalized rationale, no raw transcript
};

export type StructuredInsight =
  | TaskCategoryInsight
  | RoutinePatternInsight
  | EnergyStressInsight
  | AutomationCandidateInsight;
```

### 6.4 Правила privacy для insights

1. `employeeId` — только privacy-safe pseudonym.
2. Не добавлять `telegramUserId`, ФИО, username, телефон, email.
3. Не хранить полный текст сообщения в insight.
4. `label`, `interferesWith`, `rationale` должны быть короткими normalized labels.
5. Raw message остаётся только в dialogue/event log MVP; future aggregation Phase 6 читает только `StructuredInsight`.
6. В Phase 6 отчёты используют min group size ≥5, но Phase 3 уже не должна усложнять anonymization.

---

## 7. Policy / guardrails модель

### 7.1 Новый файл

`src/domain/work-policy.ts` или `src/domain/policy.ts`.

### 7.2 Типы

```ts
export type WorkRelevance = "work_related" | "ambiguous" | "out_of_scope";

export type WorkPolicyReason =
  | "workday_reflection"
  | "planning_or_prioritization"
  | "work_emotional_state"
  | "content_generation_request"
  | "web_research_request"
  | "ai_training_request"
  | "non_work_topic"
  | "unknown";

export type WorkPolicyDecision = {
  relevance: WorkRelevance;
  allowedForAgent: boolean;
  shouldExtractInsights: boolean;
  reason: WorkPolicyReason;
  refusalResponse?: string;
};
```

### 7.3 MVP policy rules

Файл: `src/application/work-policy.ts`.

```ts
export type WorkPolicy = {
  evaluate(input: {
    employeeId: string;
    threadId: string;
    text: string;
    profile?: UserProfile;
  }): WorkPolicyDecision;
};
```

Минимальные deterministic правила:

| Pattern | Decision |
|---|---|
| «напиши пост», «сделай пост», «пост для соцсети» | `out_of_scope`, `allowedForAgent=false`, `shouldExtractInsights=false`, reason `content_generation_request` |
| «напиши письмо», «составь КП», «сделай презентацию за меня» | `out_of_scope`, no insights |
| «найди в интернете», «проверь сайт», «собери research» | `out_of_scope`, no insights |
| «научи пользоваться ChatGPT/нейросетью» без связи с рабочим днём | `out_of_scope` или `ambiguous`, no insights |
| «сегодня приоритет», «план», «не успел», «весь день на звонках», «устал после встреч» | `work_related`, insights allowed |
| непонятный короткий текст | `ambiguous`, agent allowed, insights disabled by default |

### 7.4 Refusal response

Отказ строится deterministic helper-ом, не LLM:

```ts
export function buildWorkBoundaryResponse(decision: WorkPolicyDecision): string
```

Пример для `efficiency`:

```text
Я не пишу посты или рабочие материалы за тебя. Могу помочь быстро разобрать рабочий день: что сейчас главный приоритет, что мешает и какой следующий шаг?
```

Пример для `support`:

```text
Я не пишу посты и материалы за тебя. Зато могу помочь бережно разложить рабочий день: что важно, что забирает силы и с какого маленького шага начать?
```

### 7.5 Событие guardrail

Расширить `src/domain/events.ts`:

```ts
export type WorkBoundaryApplied = {
  type: "WorkBoundaryApplied";
  employeeId: string;
  threadId: string;
  reason: WorkPolicyReason;
  timestamp: string;
};
```

Правило: событие эмитится только когда `allowedForAgent=false` или когда `ambiguous` явно блокирует extraction.

---

## 8. Conversation memory boundary

Mastra Memory — runtime capability. Для specs нужен deterministic context без LLM.

### 8.1 Новый файл

`src/application/conversation-memory-store.ts`

```ts
export type ConversationTurn = {
  messageId: string;
  employeeId: string;
  threadId: string;
  userText: string;
  agentResponse: string;
  timestamp: string;
};

export type ConversationMemoryStore = {
  getRecentTurns(input: {
    employeeId: string;
    threadId: string;
    limit: number;
  }): Promise<ConversationTurn[]>;
};
```

На Phase 3 `saveTurn` не обязателен, потому что `MinutkaService.chat()` уже сохраняет `world.messages`. Adapter читает из `world.messages`.

### 8.2 In-memory adapter

`src/application/in-memory-conversation-memory.ts`

```ts
export function createInMemoryConversationMemory(
  world: InMemoryWorld,
): ConversationMemoryStore
```

Поведение:

- фильтр по `employeeId` + `threadId`;
- сортировка по timestamp/order insertion;
- вернуть последние `limit` turns;
- не включать текущее сообщение, потому что текущий turn ещё не сохранён до agent call.

### 8.3 AgentRunContext extension

Расширить `src/application/minutka-service.ts`:

```ts
export type AgentMemoryContext = {
  resourceId: string;
  threadId: string;
  recentTurns: ConversationTurn[];
};

export type AgentRunContext = {
  profile?: UserProfile;
  systemContext?: string;
  purpose: "chat" | "onboarding_first_response";
  memory?: AgentMemoryContext;
  policy?: WorkPolicyDecision;
};
```

Старые mock runners остаются совместимыми, потому что второй аргумент optional.

---

## 9. Mastra Memory integration

### 9.1 Установить dependency

```bash
npm install @mastra/memory
```

### 9.2 Новый файл

`src/mastra/memory.ts`

```ts
import { Memory } from "@mastra/memory";

export const minutkaMemory = new Memory({
  options: {
    lastMessages: 20,
    generateTitle: false,
  },
});
```

Если установленная версия требует другой shape — следовать embedded docs и typecheck.

### 9.3 Подключить к агенту

`src/mastra/agents/minutka-agent.ts`:

```ts
import { minutkaMemory } from "../memory.js";

export const minutkaAgent = new Agent({
  // ...
  memory: minutkaMemory,
});
```

### 9.4 Передать memory в runtime bridge

`src/mastra/agent-runner.ts`:

```ts
export const runMinutkaAgent: AgentRunner = async (input, context) => {
  const result = await minutkaAgent.generate(input.text, {
    system: context?.systemContext,
    memory: context?.memory
      ? {
          resource: context.memory.resourceId,
          thread: context.memory.threadId,
        }
      : undefined,
  });
  return result.text ?? "";
};
```

Правила:

- `resource` = `employeeId`.
- `thread` = `threadId`.
- Не передавать raw Telegram ID.
- Specs не вызывают `runMinutkaAgent`, а используют mock runner.

### 9.5 Smoke проверки

В specs или отдельном smoke внутри Phase 3 проверить:

- `minutkaAgent` импортируется;
- `runMinutkaAgent` импортируется;
- `minutkaMemory` импортируется;
- `extractInsightsTool` импортируется;
- typecheck подтверждает актуальность Mastra API.

Не вызывать реальную модель без API key.

---

## 10. Insight extraction boundary

### 10.1 Новый файл

`src/application/insight-extractor.ts`

```ts
export type InsightExtractionInput = {
  employeeId: string;
  threadId: string;
  messageId: string;
  text: string;
  response: string;
  profile?: UserProfile;
  recentTurns: ConversationTurn[];
  policy: WorkPolicyDecision;
};

export type InsightExtractionResult = {
  insights: StructuredInsight[];
};

export type InsightExtractor = (
  input: InsightExtractionInput,
) => Promise<InsightExtractionResult>;
```

### 10.2 Deterministic extractor

`src/application/deterministic-insight-extractor.ts`

Цель: дать стабильный MVP extractor для specs, не претендующий на полноту.

Минимальные lexical rules:

| Input cue | Insight |
|---|---|
| `отчёт`, `квартальный отчёт`, `report` | `task_category: reporting` |
| `звонк`, `созвон`, `встреч` | `task_category: meetings` |
| `весь день на звонках`, `встречи съели день`, `созвоны мешали` | `routine_pattern: meeting_overload`, label `звонки/встречи` |
| `не успел`, `не успела`, `не продвинулся`, `заблокирован` | `energy_stress_marker: blocked_progress` |
| `устал`, `устала`, `выгорел`, `сил нет` | `energy_stress_marker: fatigue` |
| `каждый день отчёт`, `ручной отчёт`, `копирую данные` | `automation_candidate: report_generation` или `data_entry_reduction` |
| meeting overload repeated ≥2 turns | `automation_candidate: meeting_reduction` |

Для `SPEC-CONTEXT-001` достаточно, чтобы вечерний текст:

```text
Отчёт не успел, весь день на звонках.
```

создал как минимум:

1. `task_category` с `category="reporting"` или `meetings`;
2. `routine_pattern` с `patternType="meeting_overload"`, label содержит `звонки`;
3. `energy_stress_marker` с `marker="blocked_progress"` или `fatigue`/`overload`.

### 10.3 Insight ids

Добавить counter в `InMemoryWorld`:

```ts
counters: { message: number; participant: number; insight: number }
```

ID pattern:

```text
ins_1
ins_2
...
```

Если extractor является pure function, ID можно назначать в service перед сохранением. Предпочтительно: extractor возвращает insight drafts без id, а service присваивает id/timestamp.

Более чистый вариант:

```ts
export type StructuredInsightDraft = Omit<StructuredInsight, "id" | "createdAt">;
```

Тогда `InsightExtractor` возвращает drafts, а service отвечает за IDs.

---

## 11. Insight store

### 11.1 Новый файл

`src/application/insight-store.ts`

```ts
export type InsightStore = {
  saveInsights(insights: StructuredInsight[]): Promise<void>;
  listInsights(input: {
    employeeId?: string;
    threadId?: string;
    kind?: InsightKind;
  }): Promise<StructuredInsight[]>;
};
```

### 11.2 In-memory adapter

`src/application/in-memory-insight-store.ts`

```ts
export function createInMemoryInsightStore(world: InMemoryWorld): InsightStore
```

`InMemoryWorld` добавить:

```ts
insights: StructuredInsight[];
```

### 11.3 Events

Расширить `src/domain/events.ts`:

```ts
export type InsightRecorded = {
  type: "InsightRecorded";
  employeeId: string;
  threadId: string;
  insightId: string;
  kind: InsightKind;
  timestamp: string;
};
```

Опционально, если нужно видеть попытки extraction:

```ts
export type InsightExtractionSkipped = {
  type: "InsightExtractionSkipped";
  employeeId: string;
  threadId: string;
  reason: WorkPolicyReason | "no_relevant_signal";
  timestamp: string;
};
```

Для Phase 3 достаточно `InsightRecorded` + `WorkBoundaryApplied`.

---

## 12. Mastra `extractInsightsTool`

### 12.1 Решение

Добавить Mastra tool как primitive, но не делать его источником правды для specs.

Application service вызывает `InsightExtractor` boundary напрямую. Tool нужен:

- для Mastra primitive roadmap;
- для будущих agent/tool flows;
- для smoke import;
- чтобы инструкции агента были согласованы с planned tools.

### 12.2 Файл

`src/mastra/tools/extract-insights-tool.ts`

### 12.3 Tool shape

```ts
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { extractInsightDraftsDeterministically } from "../../application/deterministic-insight-extractor.js";

export const extractInsightsTool = createTool({
  id: "extract-insights-tool",
  description:
    "Extract privacy-safe structured workday signals from an explicitly work-related Minutka reflection.",
  inputSchema: z.object({
    employeeId: z.string().min(1),
    threadId: z.string().min(1),
    messageId: z.string().min(1),
    text: z.string().min(1),
  }),
  outputSchema: z.object({
    insights: z.array(
      z.object({
        kind: z.enum([
          "task_category",
          "routine_pattern",
          "energy_stress_marker",
          "automation_candidate",
        ]),
        label: z.string(),
        confidence: z.enum(["low", "medium", "high"]),
      }),
    ),
  }),
  execute: async (input) => {
    // Minimal tool: pure extraction, no persistence side effects.
    // Persistence remains in application service for deterministic specs.
    const insights = extractInsightDraftsDeterministically(input);
    return {
      insights: insights.map(({ kind, label, confidence }) => ({
        kind,
        label,
        confidence,
      })),
    };
  },
});
```

Фактические типы привести к установленной версии Mastra и Zod.

### 12.4 Export and agent wiring

`src/mastra/tools/index.ts`:

```ts
export { updateProfileTool } from "./update-profile-tool.js";
export { extractInsightsTool } from "./extract-insights-tool.js";
```

`src/mastra/agents/minutka-agent.ts`:

```ts
import { extractInsightsTool, updateProfileTool } from "../tools/index.js";

// ...
tools: { updateProfileTool, extractInsightsTool }
```

### 12.5 Agent instructions update

Добавить в инструкции `MinutkaAgent`:

- извлекать инсайты только из рабочих рефлексий и планов;
- не извлекать инсайты из запросов на написание постов, писем, КП, web research;
- не сохранять ФИО, внешние IDs, личные детали и raw transcript в structured insights;
- если пользователь выходит за рамки — мягко вернуть к рабочему дню.

---

## 13. Application service changes

Файл: `src/application/minutka-service.ts`.

### 13.1 Dependencies

Текущий constructor:

```ts
constructor(
  private readonly world: InMemoryWorld,
  private readonly agentRunner: AgentRunner,
  private readonly profileStore: ProfileStore = createInMemoryProfileStore(world),
) {}
```

Для Phase 3 лучше перейти к optional dependency object, сохранив обратную совместимость call sites.

Минимальный вариант без overload:

```ts
export type MinutkaServiceDeps = {
  profileStore?: ProfileStore;
  conversationMemory?: ConversationMemoryStore;
  insightStore?: InsightStore;
  insightExtractor?: InsightExtractor;
  workPolicy?: WorkPolicy;
};

constructor(
  private readonly world: InMemoryWorld,
  private readonly agentRunner: AgentRunner,
  deps: MinutkaServiceDeps = {},
) {
  this.profileStore = deps.profileStore ?? createInMemoryProfileStore(world);
  this.conversationMemory =
    deps.conversationMemory ?? createInMemoryConversationMemory(world);
  this.insightStore = deps.insightStore ?? createInMemoryInsightStore(world);
  this.insightExtractor =
    deps.insightExtractor ?? createDeterministicInsightExtractor(world);
  this.workPolicy = deps.workPolicy ?? createDefaultWorkPolicy();
}
```

Потребуется обновить `createInProcessServer` и specs. Старые specs создают через harness/server, поэтому blast radius небольшой.

Альтернатива: оставить третий аргумент `profileStore`, добавить четвёртый `deps`; но это хуже для дальнейших фаз.

### 13.2 Chat behavior

Псевдокод:

```ts
async chat(input: ChatInput): Promise<ChatResult> {
  const messageId = this.nextMessageId();
  const timestamp = this.world.now();

  emit ChatMessageReceived;

  const profile = await this.profileStore.getProfile(input.employeeId);
  const recentTurns = await this.conversationMemory.getRecentTurns({
    employeeId: input.employeeId,
    threadId: input.threadId,
    limit: 10,
  });

  const policy = this.workPolicy.evaluate({ ...input, profile });

  let response: string;
  if (!policy.allowedForAgent) {
    response = policy.refusalResponse ?? buildWorkBoundaryResponse(policy, profile);
    emit WorkBoundaryApplied;
  } else {
    response = await this.agentRunner(input, {
      profile,
      systemContext: profile ? buildMinutkaProfileContext(profile) : undefined,
      purpose: "chat",
      memory: {
        resourceId: input.employeeId,
        threadId: input.threadId,
        recentTurns,
      },
      policy,
    });
  }

  save ChatMessage;
  emit ChatResponseGenerated;

  if (policy.shouldExtractInsights) {
    const extraction = await this.insightExtractor({
      employeeId: input.employeeId,
      threadId: input.threadId,
      messageId,
      text: input.text,
      response,
      profile,
      recentTurns,
      policy,
    });
    const insights = assignInsightIdsAndTimestamps(extraction.insights);
    await this.insightStore.saveInsights(insights);
    emit InsightRecorded for each insight;
  }

  return { messageId, response };
}
```

### 13.3 Не ломать onboarding

`completeOnboarding()` вызывает `agentRunner` с purpose `onboarding_first_response`. Для него:

- `memory` можно не передавать;
- `policy` можно не передавать;
- insight extraction не запускается.

### 13.4 ChatResult contract

Существующий `ChatResult` лучше не расширять, чтобы не ломать CLI/SDK:

```ts
export type ChatResult = {
  messageId: string;
  response: string;
};
```

Insights доступны через separate method `listInsights()` и `world.insights` в specs.

---

## 14. Server API surface

Файл: `src/server/http/in-process-server.ts`.

Добавить:

```ts
listInsights(input: {
  employeeId?: string;
  threadId?: string;
  kind?: InsightKind;
}) {
  return service.listInsights(input);
}
```

Обновить `createInProcessServer` под `MinutkaServiceDeps`:

```ts
export function createInProcessServer(
  world: InMemoryWorld,
  agentRunner: AgentRunner,
  deps: MinutkaServiceDeps = {},
) {
  const service = new MinutkaService(world, agentRunner, deps);
  // ...
}
```

Если нужно сохранить compatibility с Phase 2 третьим аргументом `ProfileStore`, можно сделать overload, но лучше обновить harness и call sites сразу.

---

## 15. SDK validation

Файл: `src/client/sdk/minutka-client.ts`.

Добавить schemas:

```ts
const insightKind = z.enum([
  "task_category",
  "routine_pattern",
  "energy_stress_marker",
  "automation_candidate",
]);

const structuredInsight = z.discriminatedUnion("kind", [
  // task_category schema
  // routine_pattern schema
  // energy_stress_marker schema
  // automation_candidate schema
]);

const listInsightsRequest = z.strictObject({
  employeeId: z.string().min(1).optional(),
  threadId: z.string().min(1).optional(),
  kind: insightKind.optional(),
});

const listInsightsResponse = z.array(structuredInsight);
```

Добавить method:

```ts
async listInsights(input: z.input<typeof listInsightsRequest>) {
  const validated = validate(listInsightsRequest, input, "listInsights request");
  const result = await this.api.listInsights(validated);
  return validate(listInsightsResponse, result, "listInsights response");
}
```

Export types:

```ts
export type StructuredInsightResult = z.infer<typeof structuredInsight>;
```

---

## 16. CLI commands

Файл: `src/client/cli/minutka-cli.ts`.

Существующие команды сохранить.

Добавить:

### 16.1 `employee insights`

```bash
employee insights \
  --employee emp_test_1 \
  --thread thread_test_1
```

Optional filter:

```bash
employee insights \
  --employee emp_test_1 \
  --kind routine_pattern
```

Вывод JSON array:

```json
[
  {
    "id": "ins_1",
    "employeeId": "emp_test_1",
    "threadId": "thread_test_1",
    "sourceMessageId": "msg_2",
    "kind": "routine_pattern",
    "label": "звонки",
    "patternType": "meeting_overload",
    "confidence": "medium",
    "createdAt": "2026-07-08T10:00:00.000Z"
  }
]
```

### 16.2 Не добавлять policy CLI

`policy-check` не нужен для MVP. Guardrails проверяются через `employee chat`.

---

## 17. Executable spec: `SPEC-CONTEXT-001`

Новый файл:

`specs/executable/context/SPEC-CONTEXT-001.spec.ts`

### 17.1 Metadata

```ts
registerSpecMetadata({
  id: "SPEC-CONTEXT-001",
  userStory: "US-CONTEXT-001",
  requirements: [
    "FR-CONTEXT-001",
    "FR-MEMORY-001",
    "FR-INSIGHTS-001",
  ],
  productParts: [
    "ai-agent-backend-runtime",
    "data-storage-and-privacy-layer",
  ],
  contracts: ["chat", "listInsights"],
  events: [
    "ChatMessageReceived",
    "ChatResponseGenerated",
    "InsightRecorded",
  ],
  mastra: ["minutkaAgent", "minutkaMemory", "extractInsightsTool"],
  cli: ["employee chat", "employee insights"],
});
```

### 17.2 Given

- Onboarded employee `emp_test_1` with persona `efficiency`.
- Thread `thread_test_1`.
- Mock agent runner records every `AgentRunContext`.
- Mock agent runner for evening message checks `context.memory.recentTurns` and returns response referencing morning plan.

Можно добавить helper:

```ts
await onboardTestEmployee(spec, { persona: "efficiency" });
```

### 17.3 When

1. Morning:

```bash
employee chat \
  --employee emp_test_1 \
  --thread thread_test_1 \
  --text "Сегодня приоритет — закрыть квартальный отчёт."
```

2. Evening:

```bash
employee chat \
  --employee emp_test_1 \
  --thread thread_test_1 \
  --text "Отчёт не успел, весь день на звонках."
```

3. Inspect insights:

```bash
employee insights --employee emp_test_1 --thread thread_test_1
```

### 17.4 Then

- Morning chat returns normal agent response.
- Evening agent call receives `context.memory`:
  - `resourceId = emp_test_1`;
  - `threadId = thread_test_1`;
  - `recentTurns` contains morning text and morning response.
- Evening response contains reference to morning priority:
  - `квартальный отчёт` or `утренний план`.
- `world.messages` contains 2 messages in same thread.
- `world.insights` / CLI insights include:
  - at least one `routine_pattern` with label containing `звон` and `patternType="meeting_overload"`;
  - at least one `energy_stress_marker` with marker `blocked_progress`, `overload` or `fatigue`;
  - at least one task category for `reporting` or `meetings`.
- Every insight references `sourceMessageId` of the relevant message and does not include raw full text.
- `InsightRecorded` emitted for saved insights.
- Mastra smoke imports pass:
  - `minutkaAgent`;
  - `minutkaMemory`;
  - `extractInsightsTool`;
  - `runMinutkaAgent`.

### 17.5 Pseudocode

```ts
describe("SPEC-CONTEXT-001", () => {
  it("uses morning plan in evening reflection and records insights", async () => {
    const observedRuns: Array<{ input: ChatInput; context?: AgentRunContext }> = [];
    const mockAgentRunner: AgentRunner = async (input, context) => {
      observedRuns.push({ input, context });
      const morning = context?.memory?.recentTurns.find((turn) =>
        turn.userText.includes("квартальный отчёт"),
      );
      if (input.text.includes("Отчёт не успел") && morning) {
        return "Вижу: утром главным был квартальный отчёт, но день забрали звонки. Давай выделим следующий маленький шаг.";
      }
      return "Зафиксировал приоритет дня.";
    };

    const spec = createSpecWorld(mockAgentRunner);
    await onboardTestEmployee(spec, { persona: "efficiency" });

    await spec.cli.json([...morning chat...]);
    const evening = await spec.cli.json<ChatResult>([...evening chat...]);

    expect(evening.response).toContain("квартальный отчёт");
    expect(observedRuns.at(-1)?.context?.memory?.recentTurns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userText: expect.stringContaining("квартальный отчёт") }),
      ]),
    );

    const insights = await spec.cli.json<StructuredInsightResult[]>([
      "employee", "insights", "--employee", testEmployee.employeeId, "--thread", testEmployee.threadId,
    ]);

    expect(insights).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "routine_pattern", patternType: "meeting_overload" }),
    ]));
  });
});
```

---

## 18. Executable spec: `SPEC-GUARDRAILS-001`

Новый файл:

`specs/executable/guardrails/SPEC-GUARDRAILS-001.spec.ts`

### 18.1 Metadata

```ts
registerSpecMetadata({
  id: "SPEC-GUARDRAILS-001",
  userStory: "US-GUARDRAILS-001",
  requirements: ["FR-GUARDRAILS-001", "FR-INSIGHTS-PRIVACY-001"],
  productParts: [
    "ai-agent-backend-runtime",
    "data-storage-and-privacy-layer",
  ],
  contracts: ["chat", "listInsights"],
  events: [
    "ChatMessageReceived",
    "WorkBoundaryApplied",
    "ChatResponseGenerated",
  ],
  mastra: ["minutkaAgent", "extractInsightsTool"],
  cli: ["employee chat", "employee insights"],
});
```

### 18.2 Given

- Onboarded employee with profile.
- Mock agent runner increments counter if called.
- Thread `thread_guardrails_1`.

### 18.3 When

```bash
employee chat \
  --employee emp_test_1 \
  --thread thread_guardrails_1 \
  --text "Напиши мне пост для соцсети"
```

### 18.4 Then

- Response is a soft refusal:
  - contains `не пишу посты` or `не могу писать посты`;
  - contains return-to-workday phrase like `рабочий день`, `приоритет`, `что мешает`, `следующий шаг`.
- Agent runner is not called for the blocked message.
- `WorkBoundaryApplied` emitted with reason `content_generation_request`.
- `ChatMessageReceived` and `ChatResponseGenerated` still emitted, so dialogue log remains complete.
- No insights are saved for this message.
- `employee insights --employee emp_test_1 --thread thread_guardrails_1` returns `[]`.
- `extractInsightsTool` is not involved in application flow for blocked message.

### 18.5 Negative/edge cases in same spec file

1. **Unknown/ambiguous message does not produce insights**
   - text: `ну такое`
   - agent may be called;
   - `shouldExtractInsights=false`;
   - no insights.

2. **Work reflection still allowed**
   - text: `Сегодня весь день были встречи, не успел отчёт`
   - agent called;
   - insights created.

3. **Policy is persona-safe**
   - support persona refusal is warmer;
   - efficiency persona refusal is shorter;
   - both preserve same boundary.

---

## 19. Spec harness changes

Файлы:

- `specs/executable/support/spec-harness.ts`
- `specs/executable/support/fixtures.ts`
- optionally new `specs/executable/support/onboarding-helper.ts`

### 19.1 `createSpecWorld` deps

Allow injection of Phase 3 dependencies:

```ts
export type CreateSpecWorldOptions = {
  deps?: Partial<MinutkaServiceDeps>;
};

export function createSpecWorld(
  agentRunner: AgentRunner,
  options: CreateSpecWorldOptions = {},
): SpecWorld
```

`CliDriver` may need update to pass deps to `createInProcessServer`.

### 19.2 Helper for onboarding

Avoid duplicating onboarding steps in Phase 3 specs:

```ts
export async function onboardTestEmployee(
  spec: SpecWorld,
  profileOverrides: Partial<typeof testProfile> = {},
) {
  await spec.cli.json(["employee", "open-invite", ...]);
  await spec.cli.json(["employee", "accept-consent", "--yes", ...]);
  await spec.cli.json(["employee", "complete-onboarding", ...]);
}
```

### 19.3 Fixtures

Extend `fixtures.ts`:

```ts
export const morningPlanText =
  "Сегодня приоритет — закрыть квартальный отчёт.";

export const eveningReflectionText =
  "Отчёт не успел, весь день на звонках.";

export const outOfScopePostRequest =
  "Напиши мне пост для соцсети";
```

---

## 20. Изменения по файлам

Ожидаемая структура после этапа:

```text
src/
├── domain/
│   ├── employee.ts
│   ├── events.ts                         # + WorkBoundaryApplied, InsightRecorded
│   ├── insights.ts                       # new
│   ├── privacy.ts
│   └── work-policy.ts                    # new, policy decision types
├── application/
│   ├── conversation-memory-store.ts      # new
│   ├── deterministic-insight-extractor.ts# new
│   ├── in-memory-conversation-memory.ts  # new
│   ├── in-memory-insight-store.ts        # new
│   ├── in-memory-profile-store.ts
│   ├── in-memory-world.ts                # + insights, insight counter
│   ├── insight-extractor.ts              # new
│   ├── insight-store.ts                  # new
│   ├── minutka-context-builder.ts
│   ├── minutka-service.ts                # chat flow + policy + memory + insights
│   ├── profile-store.ts
│   └── work-policy.ts                    # new deterministic rules/refusal
├── server/
│   └── http/
│       └── in-process-server.ts          # + deps object, listInsights
├── client/
│   ├── sdk/
│   │   └── minutka-client.ts             # + insight schemas/method
│   └── cli/
│       └── minutka-cli.ts                # + employee insights
└── mastra/
    ├── agent-runner.ts                   # passes memory resource/thread
    ├── agents/
    │   └── minutka-agent.ts              # + memory + extractInsightsTool instructions
    ├── index.ts
    ├── memory.ts                         # new
    └── tools/
        ├── extract-insights-tool.ts       # new
        ├── index.ts                      # + export
        └── update-profile-tool.ts

specs/executable/
├── context/
│   └── SPEC-CONTEXT-001.spec.ts          # new
├── guardrails/
│   └── SPEC-GUARDRAILS-001.spec.ts       # new
├── onboarding/
│   └── SPEC-ONBOARDING-001.spec.ts       # remains green
├── skeleton/
│   └── SPEC-SKELETON-001.spec.ts         # remains green
└── support/
    ├── cli-driver.ts                     # maybe deps passthrough
    ├── fixtures.ts                       # + context/guardrail texts
    ├── onboarding-helper.ts              # optional new
    └── spec-harness.ts                   # + world deps/helper
```

---

## 21. Порядок реализации

| # | Действие | Проверка |
|---:|---|---|
| 1 | Убедиться, что старт от `phase-2-onboarding` и working tree чистый | `git status`, `git tag --list` |
| 2 | Перечитать embedded Mastra docs по Memory, `Agent.generate()`, `createTool()` | `read node_modules/...` |
| 3 | Установить `@mastra/memory` | `npm install @mastra/memory` |
| 4 | Добавить domain `insights.ts` и `work-policy.ts` | `npm run typecheck` |
| 5 | Расширить domain events | `npm run typecheck` |
| 6 | Расширить `InMemoryWorld`: `insights`, `counters.insight` | `npm run typecheck` |
| 7 | Добавить `InsightStore` + in-memory adapter | `npm run typecheck` |
| 8 | Добавить conversation memory store + in-memory adapter over `world.messages` | `npm run typecheck` |
| 9 | Добавить deterministic `WorkPolicy` и refusal builder | `npm run typecheck` |
| 10 | Добавить `InsightExtractor` + deterministic extractor | `npm run typecheck` |
| 11 | Расширить `AgentRunContext` memory/policy полями | `npm run typecheck` |
| 12 | Переписать `MinutkaService.chat()` flow: load context → policy → agent/refusal → save → extraction | `npm run typecheck` |
| 13 | Добавить `listInsights()` в service | `npm run typecheck` |
| 14 | Обновить in-process server под deps и `listInsights()` | `npm run typecheck` |
| 15 | Обновить SDK schemas/methods | `npm run typecheck` |
| 16 | Добавить CLI `employee insights` | `npm run typecheck` |
| 17 | Добавить `src/mastra/memory.ts`, подключить memory к agent | `npm run typecheck` |
| 18 | Обновить `runMinutkaAgent` для Mastra `memory.resource/thread` | `npm run typecheck` |
| 19 | Добавить `extractInsightsTool`, export, подключение к agent | `npm run typecheck` |
| 20 | Обновить agent instructions по insights/guardrails/privacy | `npm run typecheck` |
| 21 | Обновить spec harness/fixtures/onboarding helper | `npm run typecheck` |
| 22 | Написать `SPEC-CONTEXT-001` красной/зелёной итерацией | `npm run specs -- SPEC-CONTEXT-001` или `npm run specs` |
| 23 | Написать `SPEC-GUARDRAILS-001` красной/зелёной итерацией | `npm run specs -- SPEC-GUARDRAILS-001` или `npm run specs` |
| 24 | Прогнать все specs | `npm run specs` |
| 25 | Полная проверка | `npm run verify && nix run .#verify` |
| 26 | Коммит и тег | `git add . && git commit -m "Implement phase 3 context insights" && git tag phase-3-context-insights` |

---

## 22. Риски и решения

| Риск | Решение |
|---|---|
| Mastra Memory API отличается от ожиданий | Перед кодом перечитать embedded docs; typecheck как обязательная проверка; specs не зависят от Mastra Memory runtime. |
| `@mastra/memory` потянет storage/provider сложности | Использовать minimal `new Memory({ options: { lastMessages: 20 } })`; если нужен явный storage — добавить `@mastra/libsql` отдельным шагом. |
| LLM не всегда вспомнит утренний план | Executable spec проверяет context boundary через mock runner; реальный LLM/Mastra Memory — только smoke/manual. |
| Guardrails станут слишком широкими и будут блокировать рабочие сообщения | MVP policy ограничить явными паттернами запретных запросов; ambiguous пропускать агенту, но не извлекать insights. |
| Insights начнут хранить raw text | Domain shape не содержит raw transcript; specs проверяют отсутствие полного текста в insight JSON. |
| Telegram Phase 4 начнёт обходить policy | Telegram handler обязан вызывать тот же SDK/Application `chat()`, где policy уже встроена. |
| Много constructor dependencies сломают старые specs | Ввести `MinutkaServiceDeps` и обновить один `createInProcessServer`/harness; не менять публичный `chat` contract. |
| `registerSpecMetadata` начнёт падать из-за событий других specs | Проверять metadata per spec осторожно; новые specs должны реально вызывать declared CLI/events. |

---

## 23. Manual smoke после реализации

После зелёных specs выполнить локально через CLI/harness или небольшой script:

1. Onboard employee.
2. Morning chat:

```bash
employee chat --employee emp_demo --thread day_1 --text "Сегодня приоритет — закрыть квартальный отчёт."
```

3. Evening chat:

```bash
employee chat --employee emp_demo --thread day_1 --text "Отчёт не успел, весь день на звонках."
```

4. Insights:

```bash
employee insights --employee emp_demo --thread day_1
```

5. Guardrail:

```bash
employee chat --employee emp_demo --thread day_1 --text "Напиши мне пост для соцсети"
```

Ожидания:

- evening response references previous context in mock/spec mode;
- insights include meetings/reporting/load signals;
- post request gets refusal;
- post request does not create insight.

---

## 24. Итоговый результат этапа

После Phase 3 прототип «Минута» будет уметь:

- сохранять и передавать агенту контекст внутри рабочего thread;
- использовать Mastra Memory в runtime bridge через `resourceId` + `threadId`;
- не выходить за продуктовые границы на очевидных out-of-scope запросах;
- извлекать первые structured insights из рабочих рефлексий;
- делать это privacy-safe и deterministically проверяемо;
- подготовить базу для Phase 4 Telegram shell и Phase 6 automation map без переделки application layer.
