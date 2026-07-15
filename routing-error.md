Findings

 High — /docs объявлен частью runtime-контекста, но фактически агенту не передаётся

 ### Проблема

 vault/AGENTS.md говорит, что агент должен использовать /docs:

 │ Use /docs for active product/methodology/boundary context.

 То же самое описано в vault/docs/README.md (vault/docs/README.md#L3-L15).

 При этом процесс приватности явно указывает /docs как источник входных данных:

 vault/processes/consent_and_privacy.md#L7-L12 (vault/processes/consent_and_privacy.md#L7-L12)

 Но loader загружает только:

 - vault/AGENTS.md;
 - vault/processes/index.md;
 - файлы процессов из registry.json.

 src/application/agent-manual-loader.ts#L59-L81 (src/application/agent-manual-loader.ts#L59-L81)

 renderManualContext() также рендерит только core и выбранные process-файлы:

 src/application/agent-manual-resolver.ts#L188-L205 (src/application/agent-manual-resolver.ts#L188-L205)

 Файлы из vault/docs/ в runtime context не попадают.

 ### Последствия

 - vault/docs/methodology.md не влияет на обычный ответ агента.
 - vault/docs/product-boundary.md не передаётся основному агенту.
 - vault/docs/privacy-boundary.md не является фактическим runtime-источником.
 - Process-файлы ссылаются на вход, которого у агента нет.
 - Документация создаёт впечатление, что /docs — рабочая часть Agent Vault, хотя сейчас это только неиспользуемый контракт.

 Есть и дополнительное противоречие:

 vault/processes/consent_and_privacy.md#L11 (vault/processes/consent_and_privacy.md#L11) говорит использовать «product privacy rules and Phase 2/3 plans», а
 vault/docs/README.md#L5 (vault/docs/README.md#L5) прямо запрещает использовать implementation plans как runtime policy.

 ### Рекомендация

 Нужно выбрать один из двух вариантов:

 1. Подключить /docs фактически:
     - добавить документы в registry;
     - определить механизм выбора документов;
     - передавать выбранные документы в context;
     - добавить validation и tests.

 2. Не считать /docs runtime-инструкциями:
     - убрать /docs из runtime priority;
     - оставить документы только как developer/product documentation;
     - перенести обязательные runtime-правила в AGENTS.md или process-файлы.

 Для текущего MVP предпочтительнее первый вариант в ограниченном виде: добавить явные runtimeDocs для product-boundary, methodology и privacy-boundary, но не
 загружать все документы подряд.

 ────────────────────────────────────────────────────────────────────────────────

 High — registry.json не является фактическим источником истины для process ids

 ### Проблема

 Process ids дублируются в нескольких местах:

 - vault/processes/registry.json
 - src/application/agent-manual-types.ts
 - src/domain/conversation-decision.ts
 - src/mastra/conversation-decision-router.ts
 - src/application/conversation-decision-router.ts

 Например, hardcoded список находится здесь:

 src/application/agent-manual-types.ts#L42-L59 (src/application/agent-manual-types.ts#L42-L59)

 Domain union дублирует его:

 src/domain/conversation-decision.ts#L3-L10 (src/domain/conversation-decision.ts#L3-L10)

 Transport schema снова содержит тот же список:

 src/mastra/conversation-decision-router.ts#L10-L24 (src/mastra/conversation-decision-router.ts#L10-L24)

 Loader также принимает только заранее известные ids:

 src/application/agent-manual-loader.ts#L189-L200 (src/application/agent-manual-loader.ts#L189-L200)

 ### Последствия

 Добавление нового process-файла только через registry.json не работает:

 - loader отвергнет неизвестный id;
 - TypeScript-типы его не примут;
 - router schema его не пропустит;
 - application sanitizer его отбросит.

 Таким образом, утверждение в index.md, что router выбирает процессы из registry.json, не полностью соответствует реализации.

 ### Рекомендация

 Нужен один canonical process catalog.

 Для текущего проекта возможны два простых решения:

 #### Вариант A — registry как runtime source of truth

 - loader строит allow-list из registry.json;
 - router schema валидирует только структуру, а не конкретный статический enum;
 - process ids становятся runtime-значениями;
 - domain types используют более общий branded/string type с проверкой loader.

 #### Вариант B — код как source of truth

 - создать единый process-catalog.ts;
 - registry.json, schemas и prompt routing сверять с ним;
 - добавить executable test на полное совпадение registry и catalog.

 Для Agent Vault логичнее вариант A, поскольку смысл registry — описывать доступные процессы без изменения application-кода при каждом добавлении markdown-файла.

 ────────────────────────────────────────────────────────────────────────────────

 High — в репозитории существуют два разных process router-а

 ### Проблема

 Есть старый Agent Manual router:

 - src/mastra/agents/agent-manual-router-agent.ts#L4-L17 (src/mastra/agents/agent-manual-router-agent.ts#L4-L17)
 - src/mastra/agent-manual-router.ts#L5-L8 (src/mastra/agent-manual-router.ts#L5-L8)

 Он возвращает только:

 ```json
   {
     "selectedProcessIds": ["process_id"]
   }
 ```

 Есть новый conversationDecisionAgent, который одновременно:

 - выбирает процессы;
 - определяет workDecision;
 - решает, нужен ли insight extraction.

 src/mastra/agents/conversation-decision-agent.ts#L8-L40 (src/mastra/agents/conversation-decision-agent.ts#L8-L40)

 В production composition подключён только новый router:

 src/mastra/runtime-deps.ts#L6-L14 (src/mastra/runtime-deps.ts#L6-L14)

 А agentManualRouter остаётся опциональной зависимостью MinutkaService:

 src/application/minutka-service.ts#L131-L133 (src/application/minutka-service.ts#L131-L133)

 При этом старый router всё ещё:

 - регистрируется в src/mastra/index.ts;
 - импортируется в executable specs;
 - выглядит как полноценный production-компонент.

 ### Последствия

 Сейчас в проекте два разных концептуальных ответа на вопрос:

 │ Кто выбирает процессы агента?

 Это создаёт риск:

 - разные правила выбора process-файлов;
 - разные JSON-контракты;
 - разные fallback-сценарии;
 - тесты могут проверять старый router, а production использует новый;
 - разработчик может подключить не тот router в новом runtime composition.

 ### Рекомендация

 Нужно явно выбрать архитектуру.

 Предпочтительный вариант:

 - оставить conversationDecisionAgent как единственный production decision plane;
 - удалить или переименовать agentManualRouterAgent;
 - удалить AgentManualRouter из production-зависимостей;
 - обновить specs, чтобы они проверяли реальный production composition;
 - оставить отдельный manual router только если он нужен как самостоятельный low-level компонент, но тогда это нужно явно назвать, например processSelectionRouter.

 Сейчас старый router выглядит не как вспомогательный компонент, а как параллельная реализация той же ответственности.

 ────────────────────────────────────────────────────────────────────────────────

 High — fallback-инструкции основного агента противоречат privacy-документу

 ### Проблема

 Основной агент имеет fallback-правило:

 src/mastra/agents/minutka-agent.ts#L15-L21 (src/mastra/agents/minutka-agent.ts#L15-L21)

 ```text
   не сохраняй raw transcript, прямые PII и чувствительные личные детали
 ```

 Но runtime privacy document говорит другое:

 vault/docs/privacy-boundary.md#L7-L11 (vault/docs/privacy-boundary.md#L7-L11)

 В частности, там зафиксировано, что транскрипция голосового сообщения сохраняется как обычное приватное пользовательское сообщение в canonical conversation history.
 Она не копируется в audit, insights или aggregates.

 Получается различие:

 ┌─────────────────────┬────────────────────────────────────────────────────────────────────────────────────────┐
 │ Источник            │ Что утверждается                                                                       │
 ├─────────────────────┼────────────────────────────────────────────────────────────────────────────────────────┤
 │ minutka-agent.ts    │ Не сохранять raw transcript                                                            │
 ├─────────────────────┼────────────────────────────────────────────────────────────────────────────────────────┤
 │ privacy-boundary.md │ Raw transcript может храниться в приватной canonical history, но не в derived contours │
 ├─────────────────────┼────────────────────────────────────────────────────────────────────────────────────────┤
 │ Application runtime │ ConversationStore сохраняет пользовательский текст и ответ                             │
 └─────────────────────┴────────────────────────────────────────────────────────────────────────────────────────┘

 ### Последствия

 Агент может:

 - неправильно объяснить пользователю, сохраняется ли история;
 - считать сохранение canonical conversation history нарушением собственной инструкции;
 - путать private history с insights/audit/aggregates;
 - давать неполное или ложное privacy-объяснение при прямом вызове через Studio или fallback path.

 ### Рекомендация

 Заменить fallback-правило на точное:

 ```text
   - не копируй raw transcript в insights, audit events или company aggregates;
   - не сохраняй прямые PII в structured insights;
   - canonical private conversation history управляется application layer и не является company-visible aggregate.
 ```

 Общее правило должно жить в vault/AGENTS.md или /docs/privacy-boundary.md, а не дублироваться свободным текстом в minutka-agent.ts.

 ────────────────────────────────────────────────────────────────────────────────

 High — insightExtractorAgent объявляет process источником истины, но не получает его контент

 ### Проблема

 Инструкции extractor-а говорят:

 src/mastra/agents/insight-extractor-agent.ts#L8-L16 (src/mastra/agents/insight-extractor-agent.ts#L8-L16)

 ```text
   Use the selected insight_extraction business process as the source of truth.
 ```

 Однако фактический prompt extractor-а содержит только:

 - decision;
 - текущий текст;
 - ответ агента;
 - bounded recent turns.

 src/mastra/insight-extractor.ts#L199-L222 (src/mastra/insight-extractor.ts#L199-L222)

 Содержимое vault/processes/insight_extraction.md, vault/AGENTS.md и vault/docs/privacy-boundary.md туда не передаётся.

 Вызов агента также не получает runtime systemContext:

 src/mastra/insight-extractor.ts#L190-L197 (src/mastra/insight-extractor.ts#L190-L197)

 ### Что теряется

 Extractor не видит явно следующие правила процесса:

 - выбирать низкогранулярные business signals;
 - не создавать performance evaluation;
 - не копировать персональные narratives;
 - пропускать blocked/out-of-scope turns;
 - считать emotional/load markers рабочим контекстом, а не оценкой сотрудника;
 - учитывать privacy boundary.

 Часть этих правил продублирована в коротких instructions, но это создаёт два неполных источника истины.

 ### Рекомендация

 Сделать extractor process-driven аналогично основному агенту:

 ```text
   insight_extraction process
     + core privacy rules
     + decision projection
     + bounded conversation input
     + structured output schema
 ```

 Минимально:

 - передавать в prompt отрендеренный insight_extraction.md;
 - добавить privacy-safe context из vault/AGENTS.md;
 - проверять в application layer, что selectedProcessIds содержит insight_extraction;
 - ограничить длины label, rationale, interferesWith и удалить прямые PII до сохранения.

 Сейчас утверждение «process markdown is the source of truth» для extractor-а не выполняется полностью.

 ────────────────────────────────────────────────────────────────────────────────

 Medium — порядок selected process-файлов не фиксирован

 ### Проблема

 selectedProcessIds приходит от LLM и сохраняет порядок, в котором модель вернула ids:

 src/application/conversation-decision-router.ts#L23-L53 (src/application/conversation-decision-router.ts#L23-L53)

 Затем context builder рендерит process-файлы именно в этом порядке:

 src/application/agent-manual-resolver.ts#L197-L205 (src/application/agent-manual-resolver.ts#L197-L205)

 При этом в vault/processes/index.md нет явной модели приоритета между:

 - core;
 - lifecycle processes;
 - trigger processes;
 - cross-cutting/privacy processes;
 - mutating processes.

 ### Последствия

 Для обычного запроса порядок может быть разным:

 ```text
   core → evening_reflection → insight_extraction
 ```

 или:

 ```text
   core → insight_extraction → evening_reflection
 ```

 или:

 ```text
   core → consent_and_privacy → evening_reflection
 ```

 Если процессы когда-нибудь начнут содержать конфликтующие правила, результат будет зависеть от порядка, выбранного моделью.

 Это особенно важно для желаемого порядка:

 ```text
   1. core / обязательные правила
   2. lifecycle processes
   3. trigger-specific processes
   4. cross-cutting и mutating processes
 ```

 ### Рекомендация

 Добавить в registry явный порядок:

 ```json
   {
     "id": "core",
     "order": 0,
     "class": "core"
   }
 ```

 Или определить его в коде:

 ```ts
   const processOrder = [
     "core",
     "onboarding",
     "consent_and_privacy",
     "evening_reflection",
     "workday_guardrails",
     "insight_extraction",
     "feedback",
   ];
 ```

 Лучше использовать поле в registry и сортировать в одном месте перед:

 - rendering;
 - audit;
 - возвратом selectedProcessIds;
 - сравнением в specs.

 Важно также явно зафиксировать precedence rule:

 ```text
   core cannot be overridden;
   privacy and safety constraints override persona and convenience;
   boundary process overrides normal answer process;
   mutation processes run only after decision and authorization.
 ```

 ────────────────────────────────────────────────────────────────────────────────

 Medium — поле Mutating в process index уже устарело

 ### Проблема

 В index для feedback указано:

 vault/processes/index.md#L16 (vault/processes/index.md#L16)

 ```text
   Future feedback record.
 ```

 Но сам process уже описывает сохранённую запись:

 vault/processes/feedback.md#L25-L30 (vault/processes/feedback.md#L25-L30)

 И фактический application code уже сохраняет feedback:

 src/application/minutka-service.ts#L406-L418 (src/application/minutka-service.ts#L406-L418)

 В частности:

 ```ts
   const saved = await this.stores.feedbackStore.saveFeedback(...)
 ```

 А затем создаётся audit event.

 ### Последствия

 Index перестаёт быть точной operational map:

 - для feedback указано будущее состояние, хотя mutation уже работает;
 - поле Mutating смешивает разные понятия:
     - процесс сам меняет состояние;
     - application layer меняет состояние после решения процесса;
     - процесс только разрешает mutation;
     - процесс создаёт audit event.

 Это может запутать будущий router и разработчика, который использует index для определения side effects.

 ### Рекомендация

 Заменить Mutating на более точную структуру, например:

 ┌─────────────────────┬─────────────────────────────┬──────────────────────────────────────────┐
 │ Process id          │ Side effect owner           │ Side effect                              │
 ├─────────────────────┼─────────────────────────────┼──────────────────────────────────────────┤
 │ feedback            │ Application service         │ Saves feedback and audit event           │
 ├─────────────────────┼─────────────────────────────┼──────────────────────────────────────────┤
 │ insight_extraction  │ Application service         │ Persists structured insights             │
 ├─────────────────────┼─────────────────────────────┼──────────────────────────────────────────┤
 │ workday_guardrails  │ Application service         │ Emits boundary audit event               │
 ├─────────────────────┼─────────────────────────────┼──────────────────────────────────────────┤
 │ onboarding          │ Application onboarding flow │ Profile already persisted before process │
 ├─────────────────────┼─────────────────────────────┼──────────────────────────────────────────┤
 │ consent_and_privacy │ None                        │ No mutation                              │
 └─────────────────────┴─────────────────────────────┴──────────────────────────────────────────┘

 Либо оставить Mutating, но привести его к текущему состоянию:

 ```text
   feedback — Yes: application persists feedback
 ```

 ────────────────────────────────────────────────────────────────────────────────

 Medium — process index и process-файлы частично дублируют друг друга без проверки семантической синхронизации

 ### Проблема

 Loader проверяет, что index содержит имя каждого процесса:

 src/application/agent-manual-loader.ts#L144-L151 (src/application/agent-manual-loader.ts#L144-L151)

 Но он не проверяет:

 - совпадает ли When to select с ## When this process applies;
 - совпадает ли Mutating с Outputs/Process;
 - совпадает ли process class с appliesTo;
 - описан ли process в том же порядке, что и registry;
 - не устарели ли ссылки на фактические application use cases.

 Текущая проверка фактически сводится к:

 ```text
   index содержит `process_id`
 ```

 ### Последствия

 Index может стать устаревшей summary-картой, а router будет получать оттуда неправильную информацию. При этом npm run verify продолжит проходить.

 ### Рекомендация

 Добавить executable validation минимум для:

 - точного множества process ids;
 - порядка registry/index;
 - appliesTo;
 - side-effect metadata;
 - обязательных словесных контрактов;
 - наличия process id в schemas/domain/router;
 - наличия process-файлов в runtime context.

 Полную семантическую проверку текстов делать не обязательно, но необходимо устранить механический drift.

 ────────────────────────────────────────────────────────────────────────────────

 Положительные стороны

 Несмотря на найденные проблемы, базовая архитектура выглядит хорошо организованной:

 - vault/AGENTS.md правильно выделен как core runtime contract;
 - process-файлы имеют единый author contract;
 - routing не построен на regex/keyword policy;
 - процессные ids фильтруются через allow-list;
 - decision router и insight extractor используют structured output;
 - application layer контролирует mutations;
 - ConversationStore отделён от Mastra Memory;
 - executable specs используют injected routers и fake agent runner;
 - guardrail decision fail-closed реализован и покрыт тестами;
 - privacy boundary явно описана в core/process/docs слоях;
 - npm run verify проходит полностью.

 ────────────────────────────────────────────────────────────────────────────────

 Рекомендуемый порядок исправлений

 Шаг 1 — зафиксировать единственный decision plane

 Выбрать conversationDecisionAgent как основной router и убрать двусмысленность со старым agentManualRouterAgent.

 Шаг 2 — сделать Agent Vault реально исполняемым

 Решить судьбу /docs:

 - либо загрузка и явный runtime selection;
 - либо исключение /docs из runtime priority.

 Шаг 3 — убрать дублирование process catalog

 Сделать registry или единый catalog source of truth для:

 - process ids;
 - appliesTo;
 - order;
 - side effects;
 - optional class/priority.

 Шаг 4 — зафиксировать precedence/order

 Добавить deterministic sorting перед rendering и audit.

 Шаг 5 — синхронизировать extractor

 Передавать insight_extraction process context и privacy constraints в extractor prompt.

 Шаг 6 — исправить privacy wording

 Уточнить разницу между:

 - canonical private conversation history;
 - insights;
 - audit events;
 - company aggregates.

 Шаг 7 — усилить executable validation

 Добавить проверки не только наличия process ids, но и фактического runtime context:

 - какие /docs реально попадают в prompt;
 - какие process-файлы реально попадают в prompt;
 - в каком порядке;
 - какой router используется production composition;
 - что extractor получает свои process instructions.

 ────────────────────────────────────────────────────────────────────────────────

 Итоговый вердикт

 Verdict: request changes

 Архитектурная идея Agent Vault хорошая, а текущая реализация уже достаточно дисциплинированная: есть явные процессы, allow-list, structured routing, privacy boundary
 и application-owned state.

 Но перед дальнейшим расширением Agent Vault нужно устранить четыре системных риска:

 1. /docs заявлен как runtime-контур, но фактически не загружается.
 2. Process catalog дублируется в коде и registry.
 3. В репозитории существуют два конкурирующих router-а.
 4. Extractor и основной agent имеют неполные/противоречивые инструкции относительно privacy и process source of truth.

 Пока эти проблемы не исправлены, инструкции выглядят организованными на уровне файлов, но остаются частично несогласованными на уровне фактического
 runtime-поведения.

 Confidence: 0.95
