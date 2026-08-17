# Сравнение дефолтного агента Mastra и агента «Минутка»

> **Статус:** historical — сравнение legacy-реализации «Минутки» с базовой моделью агента Mastra. Живая архитектура текущей «Минутки»: [RFC мультитенантного контура](./rfc-minutka-tenancy-and-reporting.md) поверх унаследованного [agent-led routing](./rfc-agent-led-routing.md).
>
> **Версия Mastra на момент фиксации:** `@mastra/core 1.50.1`, `mastra 1.18.2`.
>
> Legacy `minutkaAgent` удалён из product runtime в A2.6. Текущий product agent: `src/mastra/agents/personal-assistant-agent.ts`. Остальной текст оставлен как провенанс и описывает историческую систему.

## 1. Краткий вывод

Дефолтный агент Mastra — это универсальный LLM-примитив, состоящий из модели, инструкций и, при необходимости, инструментов, памяти, processors и workflows.

Агент «Минутка» — это прикладной многопользовательский runtime поверх Mastra. Его поведение определяется не только объектом `Agent`, но и дополнительными слоями:

- предметной ролью для рабочего дня сотрудника;
- Agent Vault с версионируемыми бизнес-процессами;
- constrained decision router;
- типизированными application use cases;
- scoped runtime projections;
- PostgreSQL-хранилищами;
- privacy и consent boundary;
- изоляцией сотрудников и диалогов;
- структурированными insights и агрегатами;
- Telegram/HTTP runtime;
- executable specs и mockable `AgentRunner`.

Главная формула:

```text
Дефолтный Mastra Agent:
    instructions + model + tools + optional memory

«Минутка»:
    Mastra Agent
  + product role
  + business processes
  + decision routing
  + application-owned state
  + privacy boundary
  + scoped context
  + multi-user isolation
  + structured insights
  + audit
  + Telegram/HTTP runtime
```

---

## 2. Что такое дефолтный агент Mastra

Базовый агент Mastra создаётся примерно так:

```ts
import { Agent } from "@mastra/core/agent";

const agent = new Agent({
  id: "assistant",
  name: "Assistant",
  instructions: "You are a helpful assistant.",
  model: "openai/gpt-5.5",
});
```

К его возможностям можно добавить:

- tools для вызова внешних API и функций;
- Memory для истории, working memory и semantic/observational memory;
- `inputProcessors` и `outputProcessors` для guardrails, нормализации, PII и cost limits;
- Workflows для детерминированных последовательностей;
- Workspace и Sandbox для файлов и выполнения команд;
- Channels для Telegram, Slack, Discord и других каналов;
- structured output;
- streaming через `.stream()`;
- регистрацию в экземпляре `Mastra` и работу через Studio/API.

Однако сам Mastra не знает продуктовые правила конкретного приложения. Фреймворк не определяет автоматически:

- кто является сотрудником;
- какие темы входят в рабочий день;
- какие данные разрешено показывать компании;
- что такое персональная память пользователя;
- как отделять личные данные от агрегатов;
- когда нужно отказать в выполнении запроса;
- какие действия должен разрешать конкретный пользователь или оператор.

Это ответственность приложения, построенного поверх Mastra.

---

## 3. Архитектурная схема «Минутки»

В текущем проекте Mastra является частью более широкого application runtime:

```text
Telegram / HTTP / CLI
          ↓
   MinutkaService
          ↓
 Runtime projections
          ↓
Conversation decision router
          ↓
Agent Vault + selected processes
          ↓
    MinutkaAgent
          ↓
PostgreSQL / audit / insights
```

Основной агент — только один из компонентов. Помимо него в проекте есть специализированные Mastra-агенты:

| Агент | Ответственность |
|---|---|
| `minutkaAgent` | Основной ответ сотруднику по теме рабочего дня |
| `conversationDecisionAgent` | Выбор процессов и решение: разрешить ответ или применить границу |
| `insightExtractorAgent` | Извлечение структурированных рабочих сигналов |
| `onboardingProfileExtractorAgent` | Извлечение данных профиля из ответов онбординга |
| `agentManualRouterAgent` | Маршрутизация и работа с Agent Vault |

Таким образом, «Минутка» — это не просто один универсальный чат-агент, а координируемый набор LLM-контуров с application orchestration.

---

## 4. Сравнительная таблица

| Область | Дефолтный агент Mastra | Агент «Минутка» |
|---|---|---|
| **Основная роль** | Универсальный AI-ассистент | AI-партнёр сотрудника по разбору и планированию рабочего дня |
| **Определение поведения** | В основном `instructions` | `vault/AGENTS.md` + бизнес-процессы + runtime context |
| **Предметная область** | Не задана фреймворком | Работа сотрудника, планирование, рефлексия, нагрузка и рабочие паттерны |
| **Границы ответа** | Задаются разработчиком | Формализованы router, process allow-list и application layer |
| **Маршрутизация** | Обычно решение принимает сам агент | Отдельный `conversationDecisionAgent` до вызова основного агента |
| **Формат решений** | Часто свободный текст | Strict structured output + Zod + domain validation |
| **Память** | Mastra Memory может быть основным механизмом | Canonical conversation history принадлежит `ConversationStore` |
| **Состояние** | Может меняться через tools | Владелец состояния — application layer и typed stores |
| **Хранилище** | Выбирается конфигурацией Mastra | PostgreSQL adapters для профиля, диалога, feedback, insights и audit |
| **Многопользовательская изоляция** | `resourceId` и `threadId` | Identity mapping, ownership, trusted scope, projections и PostgreSQL constraints |
| **Privacy** | Не является встроенной продуктовой моделью | Сквозная privacy-boundary для сотрудника, методолога и компании |
| **Аналитика** | Не обязательна | Structured insights и обезличенная карта автоматизации |
| **Агрегация** | Не обязательна | Скрытие групп менее пяти сотрудников |
| **Аудит** | Может использоваться observability | Safe audit events с allow-list metadata |
| **Каналы** | Agent API, Studio и подключаемые адаптеры | Telegram, HTTP API и CLI через общий application runtime |
| **Голос** | Подключается через Voice API | Telegram voice → STT → тот же application chat path |
| **Инструменты** | Агент может сам вызывать tools | Mutating actions контролируются application use cases |
| **Тестирование** | Часто требует LLM или mocks вокруг агента | `AgentRunner` инжектируется; executable specs работают без LLM |
| **Версионирование поведения** | Обычно Git-файл с инструкциями | Git-версионируемые process-файлы, registry и traceability dependencies |
| **Sandbox** | Можно подключить Workspace/Daytona | В текущем runtime Sandbox/Daytona не подключён |
| **Workflow** | Доступен через Mastra | Основная продуктовая orchestration находится в application layer |
| **Модель** | Часть конфигурации агента | Заменяемая инфраструктурная деталь; текущая модель — `openai/gpt-5.4-mini` |

---

## 5. Предметная роль и ограничения

### 5.1. Дефолтный Mastra Agent

Базовая модель агента не имеет собственной продуктовой миссии. Например, она может быть погодным помощником, исследовательским агентом или coding agent — всё определяется инструкциями и tools.

### 5.2. «Минутка»

«Минутка» имеет строго ограниченную роль:

- слушать сотрудника;
- отражать содержание его рабочего дня;
- помогать структурировать приоритеты и блокеры;
- замечать повторяющиеся рабочие паттерны;
- обсуждать нагрузку и состояние, если они связаны с работой;
- помогать сформулировать следующий шаг.

Она не должна:

- писать за сотрудника посты, письма, коммерческие предложения, отчёты или презентации;
- выполнять рабочую задачу вместо сотрудника;
- делать web research;
- превращаться в универсальный ChatGPT;
- оценивать эффективность сотрудника;
- контролировать, стыдить или давить;
- раскрывать персональные данные компании или методологу.

Эти правила находятся в `vault/AGENTS.md` и в отдельных process-файлах, а не только в одном длинном prompt.

---

## 6. Agent Vault против одного system prompt

Обычный Mastra Agent может иметь один блок:

```ts
instructions: "You are a helpful assistant..."
```

У «Минутки» поведение разделено по логическим namespace:

```text
/AGENTS.md  → общая роль и глобальные границы
/processes  → применимые бизнес-процессы
/docs       → активные runtime-документы
/proc       → bounded projection текущего состояния
/bin        → разрешённые typed actions
/run        → safe audit/action trace
```

Физически это представлено каталогом:

```text
vault/
  AGENTS.md
  processes/
  docs/
  proc/
  bin/
  run/
```

Основные процессы:

- `onboarding`;
- `consent_and_privacy`;
- `evening_reflection`;
- `workday_guardrails`;
- `insight_extraction`.

Structured feedback callback не входит в каталог процессов: transport уже знает rating и target message, поэтому вызывает typed `submitFeedback` use case напрямую, без LLM.

Каждый процесс имеет единый контракт:

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

Преимущества такого подхода:

- отдельный сценарий можно изменять независимо от остальных;
- процесс связан с продуктовыми документами и executable specs;
- loader проверяет наличие обязательных секций и зависимостей;
- поведение агента проходит code review как обычный код;
- prompt не превращается в неуправляемый монолит.

---

## 7. Constrained decision routing

В дефолтной конфигурации агент может самостоятельно интерпретировать запрос и сразу генерировать ответ.

В «Минутке» сначала запускается decision router:

```text
Сообщение сотрудника
        ↓
conversationDecisionAgent
        ↓
strict JSON
        ↓
Zod/domain validation
        ↓
allow-list process ids
        ↓
основной агент или boundary response
```

Router определяет:

- какие business processes применимы;
- разрешён ли обычный ответ;
- является ли запрос генерацией рабочего материала;
- относится ли запрос к web research;
- является ли он нерабочим;
- нужно ли извлечь structured insight после ответа.

Например, запрос:

> «Напиши мне пост для соцсети»

не передаётся основному conversational agent. Application layer возвращает безопасный отказ и перенаправляет разговор к рабочему дню.

Это сильнее, чем инструкция «не пиши посты»: граница применяется до основной генерации и фиксируется в decision/audit projection.

---

## 8. Application-owned state вместо прямого владения агента

В типичном Mastra-приложении agent tools могут быть основным способом изменения внешнего состояния.

В «Минутке» состояние принадлежит application layer:

```text
Domain
  ↓
Application services
  ↓
PostgreSQL adapters
```

`MinutkaService` координирует:

- профиль сотрудника;
- согласие и consent version;
- onboarding draft;
- историю сообщений;
- feedback;
- structured insights;
- Telegram invite/session state;
- audit events.

Агент не получает произвольный доступ к БД и не выбирает сам, куда записывать данные.

В проекте зарегистрированы `updateProfileTool` и `extractInsightsTool`, но в текущем обычном chat path tool loop намеренно отключён через `toolChoice: "none"`. Это сохраняет контроль над побочными эффектами в application layer.

---

## 9. Memory Mastra и canonical conversation history

Mastra поддерживает Memory с `resourceId` и `threadId`, что подходит для многих обычных multi-user сценариев.

В текущей архитектуре «Минутки»:

- canonical history хранится в `ConversationStore`;
- production persistence выполняется через PostgreSQL;
- `MinutkaService` формирует bounded recent-turn context;
- Mastra Memory не является источником истины для обычного Telegram path;
- `InMemoryStore` в `src/mastra/index.ts` используется для development/Studio/import smoke;
- включение второй копии истории отложено до отдельного решения по retention, deletion и duplicate-history rules.

Причины:

- контроль удаления персональных данных;
- единая модель retention;
- отсутствие дублирования сообщений;
- ограничение размера контекста;
- восстановление данных после restart;
- независимость application state от изменения API Mastra Memory.

Итог:

> В дефолтной Mastra-конфигурации Memory может быть главным механизмом истории. В «Минутке» бизнес-состояние и conversation history принадлежат приложению, а Mastra используется как LLM/runtime integration.

---

## 10. Runtime projections и scoped context

Перед вызовом агента приложение создаёт ограниченный снимок состояния:

```text
/proc/profile
/proc/consent
/proc/thread
/proc/insights
/proc/feedback
/proc/decision
```

В prompt попадают только данные, необходимые для текущего запроса:

- профиль текущего сотрудника;
- выбранная persona;
- ограниченная история текущего thread;
- выбранное решение router;
- выбранные процессы;
- bounded structured insights.

Агент не должен иметь возможности:

- выбрать другого сотрудника;
- передать произвольный `employeeId` в запросе;
- выполнить SQL;
- прочитать всю базу;
- получить Telegram ID, invite code, телефон или email;
- увидеть данные другого thread или другого пользователя.

Это достигается не только инструкциями, а сочетанием:

- authenticated identity;
- `RuntimeAccessScope`;
- projection builder;
- field allow-list;
- character/token limits;
- trusted application boundary.

---

## 11. Privacy boundary

Privacy является одной из центральных архитектурных особенностей «Минутки».

### Сотрудник может видеть

- свой профиль;
- свою рабочую историю и summaries;
- свой персональный контекст;
- данные, которые «Минутка» о нём помнит.

### Методолог может видеть

- статус участия;
- активность;
- безопасные операционные показатели;
- агрегированные отчёты.

Методолог не должен видеть:

- raw transcripts;
- индивидуальные задачи;
- индивидуальное эмоциональное состояние;
- личные ответы сотрудника.

### Компания получает

- только агрегированные и обезличенные patterns;
- зоны повторяющейся рутины;
- кандидатов на автоматизацию;
- агрегированные признаки нагрузки.

Группы менее пяти сотрудников не показываются, чтобы снизить риск идентификации.

### Технические ограничения

Privacy boundary поддерживается на нескольких уровнях:

```text
Telegram identity
        ↓
HTTP/API authorization
        ↓
Application access scope
        ↓
Runtime projections
        ↓
Agent context
        ↓
Aggregated reporting
```

У дефолтного Mastra Agent такая бизнес-модель приватности не возникает автоматически.

---

## 12. Специализированные LLM-контуры

Вместо одной схемы:

```text
user → one agent → answer
```

«Минутка» использует разделение ответственности:

```text
user message
    ↓
conversation decision router
    ↓
main conversational agent
    ↓
insight extractor
```

Дополнительно onboarding использует профильный extractor.

| Контур | Что он делает | Что он не делает |
|---|---|---|
| Conversation router | Выбирает процессы и границы | Не пишет финальный ответ пользователю |
| Main agent | Формирует ответ сотруднику | Не решает бизнес-privacy самостоятельно |
| Insight extractor | Формирует структурированные сигналы | Не принимает privacy/legal decisions |
| Onboarding extractor | Извлекает поля профиля | Не сохраняет данные напрямую в БД |
| Application layer | Валидирует и исполняет результат | Не отдаёт модели произвольный контроль |

Это не Mastra Supervisor Network в чистом виде. Это application-controlled orchestration нескольких специализированных Mastra agents.

---

## 13. Structured output и проверяемость

Router и extractors используют строгие схемы.

Пример decision output:

```json
{
  "selectedProcessIds": ["core", "evening_reflection", "insight_extraction"],
  "workDecision": {
    "mode": "allow",
    "reason": "workday_reflection"
  },
  "insightDecision": {
    "candidate": true,
    "suggestedKinds": ["routine_pattern"]
  }
}
```

Результат проходит:

1. transport schema validation;
2. domain schema validation;
3. allow-list проверку process ids и insight kinds;
4. механическое исполнение в application layer.

LLM не может самостоятельно:

- придумать новый процесс;
- выбрать неизвестный тип insight;
- получить доступ к другому сотруднику;
- открыть произвольный путь `/proc`;
- решить, какие персональные данные вывести компании.

---

## 14. Multi-user модель

Документация Mastra предлагает для multi-user приложений разделять историю через `resourceId` и `threadId`.

В «Минутке» это только часть модели. Дополнительно используются:

- privacy-safe employee ID;
- атомарное redemption Telegram invite;
- связь Telegram identity с сотрудником;
- thread ownership;
- HTTP principal и authorization;
- application access scope;
- PostgreSQL ownership constraints;
- scoped runtime projections;
- отсутствие employee ID в доверии к пользовательскому body;
- безопасный audit.

Следовательно, изоляция не зависит только от того, правильно ли переданы `resourceId` и `threadId` в `generate()`.

---

## 15. Тестируемость без LLM-затрат

Вызов Mastra отделён от application logic через `AgentRunner`:

```ts
type AgentRunner = (
  input: ChatInput,
  context?: AgentRunContext,
) => Promise<string>;
```

В executable specs можно передать mock runner и тестировать полный application path:

```text
CLI
  → SDK
  → Server
  → MinutkaService
  → mock AgentRunner
```

Без реальных LLM-вызовов проверяются:

- onboarding;
- consent;
- persona;
- process routing;
- workday guardrails;
- context limits;
- feedback;
- insights;
- Telegram сценарии;
- persistence;
- privacy projections.

Mastra smoke и реальные provider calls проверяются отдельно.

Это отличает «Минутку» от простого приложения, где бизнес-логика неотделима от `agent.generate()`.

---

## 16. Что в текущем проекте пока не реализовано

Важно отделять архитектурное отличие от возможной будущей функции.

### 16.1. Mastra Memory не используется как production canonical history

Несмотря на наличие Mastra Memory API, текущий production path опирается на `ConversationStore` и PostgreSQL.

### 16.2. Daytona Sandbox не подключён

В установленной версии Mastra есть поддержка `Workspace` и `DaytonaSandbox`. Однако сейчас:

- `Workspace` не назначен `minutkaAgent`;
- `DaytonaSandbox` не используется;
- агент не исполняет произвольный пользовательский код;
- вычисления выполняются через application services.

Daytona может быть добавлен позднее для:

- обработки файлов;
- тяжёлых вычислений;
- изолированного выполнения Python/JS;
- персональных рабочих пространств пользователей;
- переноса вычислений из LLM-контекста в sandbox.

Но сейчас это не является характеристикой реализованного агента.

### 16.3. Встроенные Mastra processors пока не покрывают все продуктовые guardrails

Mastra предоставляет `PromptInjectionDetector`, `PIIDetector`, `ModerationProcessor`, `CostGuardProcessor`, `TokenLimiter` и другие processors.

Текущие основные бизнес-границы реализуются через:

- decision router;
- Agent Vault;
- application validation;
- runtime projections;
- typed stores.

Mastra processors могут быть добавлены как дополнительный технический слой для prompt injection, PII, cost и moderation.

### 16.4. Agent tool loop ограничен

Инструменты зарегистрированы, но обычный chat runner сейчас использует:

```ts
toolChoice: "none"
```

Это намеренно: mutating actions должны оставаться под контролем application layer.

---

## 17. Итоговая оценка

Технически `minutkaAgent` является обычным объектом Mastra `Agent`. Проект не создаёт отдельный тип агента и не заменяет Mastra.

Однако системно он отличается от дефолтного агента четырьмя фундаментальными свойствами:

1. **Узкая прикладная роль.** Он решает задачу рабочего дня сотрудника, а не произвольные вопросы.
2. **Управляемое поведение.** Решения проходят через бизнес-процессы, router, allow-list и application validation.
3. **Privacy-first multi-user runtime.** Доступ определяется trusted scope, ownership и projection boundary, а не только prompt.
4. **Внешнее владение состоянием.** Профиль, история, insights, consent и audit находятся под контролем application layer и PostgreSQL.

Корректное описание:

> **«Минутка» — это прикладной многопользовательский агент с управляемыми бизнес-процессами, privacy boundary и application-owned state, построенный поверх Mastra.**

На английском:

> **Minutka is a privacy-constrained, process-driven, multi-user application agent built on Mastra.**
