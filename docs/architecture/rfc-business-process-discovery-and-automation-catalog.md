# RFC: бизнес-процессы как основной язык исследования и карты автоматизации

## Status

**superseded (2026-09-03) → [RFC инвентаря рутин и быстрых побед](./rfc-routine-inventory-and-quick-wins.md).** Модель бизнес-процессов относится к платному этапу обследования и в runtime бесплатной «Минутки» не реализуется; текст сохранён как провенанс для этого этапа.

Исходный статус: **proposed (2026-08-31).** RFC фиксирует переход от отчётности по широким activity facets к evidence-linked модели бизнес-процессов для личного отчёта сотрудника и клиентской карты автоматизации. Решение вводит derived research layer поверх canonical messages, activities и traces; текущий надёжный контур учёта активностей сохраняется.

Related:

- [RFC исследовательского корпуса и клиентской карты автоматизации](./rfc-minutka-research-corpus-and-reporting.md)
- [Переиспользуемый паттерн research corpus/reporting](./research-corpus-reporting-pattern.md)
- [Продуктовый baseline «Минутки»](../product/Final_Description.md)
- [Шаблоны evidence pack и клиентской карты](../product/evidence-pack-and-client-report-template.md)
- [RFC линейки из трёх продуктов](./rfc-three-products-implementation.md)
- [Исследование Process Architect](../researches/rfc-ecom1-process-architect-lessons-for-time-agent.md)

---

## 1. Проблема

Текущий контур надёжно сохраняет factual activity как набор закрытых facets:

- `taskCategory`;
- `routinePattern`;
- `automationCandidate`;
- `energyStressMarker`;
- `durationBucket`;
- `system`.

Независимые optional facets, bounded activity transaction extractor, duration evidence refs, corrections, revisions и supersession повышают точность canonical activity. Однако `CompanyReportingService` по-прежнему определяет процесс как сочетание `taskCategory + routinePattern`, например:

```text
admin + manual_reporting
communication + coordination_overhead
reporting + manual_reporting
```

Такое сочетание является группой признаков, а не бизнес-процессом. Оно не описывает:

- событие, запускающее работу;
- цель и ожидаемый результат;
- объект работы;
- входные и выходные данные;
- последовательность шагов;
- передачу работы между ролями;
- направление движения данных между системами;
- активное время, ожидание и полный cycle time;
- правила, решения и исключения.

Из-за этого личный отчёт сообщает повторившиеся категории и facets, но не может назвать конкретную рабочую рутину. Клиентский отчёт находит широкие зоны ручного труда и координации, но формирует generic automation option, который методолог вручную превращает в конкретную рекомендацию после чтения полного research corpus.

В проекте уже существует доказательная основа для более предметной модели:

- canonical messages;
- active canonical activities;
- full research traces;
- source-message/activity linkage;
- group-scoped `subject_key`;
- correction, purge и recompute;
- evaluation cases и version anchors;
- отдельная граница internal evidence/client report.

Не хватает derived domain layer, который превращает отдельные наблюдения в проверяемое описание бизнес-процесса.

Термин `process` сейчас также неоднозначен. `assistant process` (`evening_reflection`, `weekly_summary`, `final_report`) описывает поведение агента, а `business process` — операционную работу компании. Поле `ResearchTrace.processIds` содержит только процессы ассистента и не является каталогом бизнес-процессов.

## 2. Решение

### 2.1. Ubiquitous language

Проект принимает следующие доменные понятия:

| Понятие | Значение |
|---|---|
| `Activity` | Фактическая единица выполненной или выполняемой работы, явно сообщённая сотрудником |
| `ProcessEpisode` | Evidence-linked наблюдение одного выполнения бизнес-процесса или его фрагмента |
| `BusinessProcessCandidate` | Гипотеза процесса, объединяющая похожие episodes и допускающая merge/split/correction |
| `BusinessProcess` | Проверенное и версионируемое описание процесса компании |
| `ProcessArchetype` | Типовой процесс без утверждения, что он существует в конкретной компании |
| `AutomationCase` | Curated переиспользуемый паттерн автоматизации и discovery-вопросов |
| `AutomationRecommendation` | Проверяемая связь конкретного business process с вариантом автоматизации |
| `AssistantProcess` | Runtime-процесс поведения агента; не является business process |

Идентификаторы различаются явно:

```text
assistantProcessId
processEpisodeId
businessProcessCandidateId
businessProcessId
automationCaseId
automationRecommendationId
```

Каждое пользовательское сообщение не становится отдельным `BusinessProcess`. Сначала из сообщения выделяется `ProcessEpisode`; стабильная identity процесса появляется только после кластеризации и проверки.

### 2.2. Слои данных

Целевой поток:

```text
canonical message
      +
canonical activity
      +
research trace
      ↓
ProcessEpisodeExtractor
      ↓
ProcessEpisode
      ↓
ProcessClusterer
      ↓
BusinessProcessCandidate
      ↓
methodologist review
      ↓
BusinessProcess
      +
AutomationCase match
      ↓
AutomationRecommendation
      ↓
personal process summary / client automation map
```

`Activity` остаётся canonical factual record. Business-process entities хранятся в research contour как пересчитываемые derived records. Ошибка process discovery не откатывает и не блокирует activity collection или durable conversation turn.

### 2.3. `ProcessEpisode`

Минимальный контракт episode:

```ts
type ProcessEpisode = {
  episodeId: string;
  companyId: string;
  groupId: string;
  subjectKey: string;
  roleId: string;

  candidateLabel?: string;
  trigger?: EvidencedValue<string>;
  action: EvidencedValue<string>;
  workObject?: EvidencedValue<string>;
  input?: EvidencedValue<string>;
  output?: EvidencedValue<string>;
  result?: EvidencedValue<string>;

  steps: ProcessEpisodeStep[];
  systems: ProcessSystemUse[];
  dataFlows: ProcessDataFlow[];
  handoffs: ProcessHandoff[];

  touchTime?: EvidencedDuration;
  waitTime?: EvidencedDuration;
  cycleTime?: EvidencedDuration;
  frequency?: EvidencedValue<string>;
  volume?: EvidencedValue<string>;

  friction?: EvidencedValue<RoutinePatternType>;
  decisions: ProcessDecisionObservation[];
  exceptions: ProcessExceptionObservation[];

  evidenceRefs: ProcessEvidenceRef[];
  extractorVersion: string;
  schemaVersion: string;
  reviewStatus: "unreviewed" | "accepted" | "corrected" | "rejected";
};
```

Каждое значимое поле различает происхождение:

```ts
type EvidenceOrigin = "stated" | "derived" | "reviewed";

type EvidencedValue<T> = {
  value: T;
  origin: EvidenceOrigin;
  confidence: "hypothesis" | "signal" | "confirmed";
  evidenceRefs: ProcessEvidenceRef[];
};
```

Правила:

1. `stated` используется для данных, явно содержащихся в сообщении сотрудника.
2. `derived` используется для исследовательской интерпретации, которую можно проверить по evidence refs.
3. `reviewed` появляется только после решения методолога.
4. Неизвестное поле отсутствует; schema не заполняется правдоподобным default.
5. Agent response не является самостоятельным factual evidence; основной источник — employee message, active activity и принятая correction history.

### 2.4. Системы и движение данных

Система хранится не только как неупорядоченный список. Для процесса вводится directed data flow:

```ts
type ProcessDataFlow = {
  from: ProcessEndpoint;
  to: ProcessEndpoint;
  dataObject?: EvidencedValue<string>;
  transferMode?: EvidencedValue<
    "manual_copy" | "file_upload" | "email" | "api" | "verbal" | "unknown"
  >;
  transformation?: EvidencedValue<string>;
  evidenceRefs: ProcessEvidenceRef[];
};
```

Пример:

```text
email
  -- реквизиты клиента / manual_copy -->
CRM

CRM
  -- данные заявки / ручная передача -->
расчётчик

результат расчёта
  -- copy-paste -->
шаблон коммерческого предложения
```

Направление, объект и способ передачи являются отдельными значениями. Наличие двух систем в одном episode не означает автоматически, что между ними передаются данные.

### 2.5. Время

Модель различает:

- `touchTime` — активное время сотрудника;
- `waitTime` — ожидание данных, решения или выполнения другой роли;
- `cycleTime` — время от trigger до результата.

Текущее `Activity.durationBucket` может подтверждать `touchTime`, но не переносится автоматически в `waitTime` или `cycleTime`. Для live extraction относительные даты и интервалы связываются application-side refs по тому же принципу, что request-local duration evidence.

### 2.6. `BusinessProcessCandidate`

Несколько похожих episodes объединяются в candidate только при совместимости ключевых признаков:

- цель/результат;
- work object;
- trigger;
- шаги;
- роли и handoffs;
- systems/data flows.

Одинаковая `taskCategory`, friction или пара систем сами по себе недостаточны для объединения.

Candidate хранит:

- canonical label;
- included episode refs;
- proposed current-state flow;
- common and variable steps;
- conflicting observations;
- missing critical fields;
- competing interpretations;
- prevalence confidence;
- extraction quality summary;
- review state.

Candidate поддерживает:

- merge;
- split;
- correction;
- rejection;
- recompute from evidence;
- invalidation после correction/purge.

### 2.7. `BusinessProcess`

После review candidate становится версионируемым tenant-scoped описанием:

```ts
type BusinessProcess = {
  businessProcessId: string;
  companyId: string;
  groupId?: string;
  version: number;

  name: string;
  purpose?: string;
  outcome: string;
  triggers: ProcessTrigger[];
  roles: ProcessRole[];
  inputs: ProcessArtifact[];
  steps: ProcessStep[];
  outputs: ProcessArtifact[];

  systems: ProcessSystemUse[];
  dataFlows: ProcessDataFlow[];
  handoffs: ProcessHandoff[];
  timing: ProcessTiming;
  frequency?: ProcessFrequency;
  volume?: ProcessVolume;

  decisions: ProcessDecision[];
  rules: ProcessRule[];
  exceptions: ProcessException[];
  frictions: ProcessFriction[];

  evidenceSummary: ProcessEvidenceSummary;
  confidence: ProcessConfidence;
  review: ProcessReviewMetadata;
  status: "candidate" | "reviewed" | "published" | "retired";
};
```

`BusinessProcess` описывает процесс, а не сотрудника. В нём отсутствуют employee identifiers, персональная оценка, настроение, лояльность и выводы о продуктивности.

### 2.8. Каталог automation cases

Проект вводит отдельный глобальный curated `AutomationCaseCatalog`. Он не является evidence компании и не повышает process confidence.

Минимальный контракт:

```ts
type AutomationCase = {
  caseId: string;
  version: number;
  name: string;
  applicableSignals: string[];
  applicableProcessTypes: string[];
  currentProblemPattern: string;
  proposedMechanism: string;
  requiredSystems: string[];
  requiredCapabilities: string[];
  prerequisites: string[];
  humanInTheLoop: string;
  contraindications: string[];
  risks: string[];
  baselineMetrics: string[];
  pilotMetrics: string[];
  discoveryQuestions: string[];
  provenance: string[];
};
```

Первая версия хранится как Markdown/YAML/JSON под Git с registry, stable IDs и версиями. Векторная БД не вводится. Deterministic filtering выбирает ограниченный набор cases для semantic matching.

Допустимые результаты matching:

```text
matched
competing_cases
no_matching_case
novel_process
```

Automation cases не участвуют в первичном process extraction, чтобы не создавать confirmation bias.

### 2.9. `AutomationRecommendation`

Рекомендация связывает reviewed business process и automation case либо отдельную reviewed гипотезу методолога:

```ts
type AutomationRecommendation = {
  recommendationId: string;
  businessProcessId: string;
  matchedCaseIds: string[];

  currentFlowSummary: string;
  proposedFlow: ProcessStep[];
  automationMechanism: string;
  humanInTheLoop: string;

  prerequisites: string[];
  risks: string[];
  expectedEffect: string;
  baselineNeeded: string[];
  nextSteps: AutomationRoadmap;

  processConfidence: ProcessConfidence;
  feasibilityConfidence: ProcessConfidence;
  effectConfidence: ProcessConfidence;
};
```

Одно поле `confidence` больше не используется для нескольких разных утверждений. Минимально различаются:

- extraction/interpretation confidence;
- process prevalence confidence;
- automation feasibility confidence;
- expected effect confidence.

### 2.10. Progressive enrichment и уточняющие вопросы

Live-уточнения вводятся только после offline backfill и evaluation. Поведение следует progressive enrichment:

1. Ежедневный turn сохраняет activity и доступные process episode fields без обязательного вопроса.
2. Агент задаёт не более одного короткого вопроса, если ответ информационно ценен для различения процессов или data flow.
3. При повторном похожем episode агент сначала предлагает подтвердить принадлежность к уже известному candidate.
4. Полное process interview выполняется отдельным bounded процессом после накопления нескольких episodes, а не внутри каждой вечерней рефлексии.
5. Пользователь может пропустить вопрос или ответить «не знаю» без потери activity.
6. Поле, уже подтверждённое предыдущими episodes, повторно не спрашивается без противоречащего evidence.
7. Усталость/перегруз не используются для усиления опроса.

Приоритет одного уточняющего вопроса:

1. ожидаемый результат;
2. направление движения данных;
3. handoff;
4. ручная операция или ожидание;
5. частота/объём;
6. правила и исключения.

### 2.11. Разделение extractors

Текущий `ActivityTransactionExtractor` не расширяется полной business-process schema. Сохраняется разделение:

```text
ActivityTransactionExtractor
  → canonical factual activities

ProcessDiscoveryExtractor
  → research process episodes/candidates
```

Process discovery не имеет прямого store-доступа и пишет только через typed research use-case. Provider/schema failure, timeout или отсутствие process evidence не меняют результат activity transaction.

### 2.12. Historical backfill

Первый исполняемый срез работает offline поверх `research-corpus-export/v2`:

```text
research-corpus-export/v2
  ↓
participant messages + active activities + trace decisions
  ↓
ProcessEpisodeExtractor
  ↓
process-episodes.jsonl
  ↓
ProcessClusterer
  ↓
business-process-candidates.json
  ↓
methodologist review
  ↓
reviewed-process-catalog.json
  ↓
process-based personal/client report drafts
```

Backfill:

- не изменяет canonical messages или activities;
- не публикует client report автоматически;
- не использует agent response как основной factual source;
- не смешивает company/group scopes;
- сохраняет extractor/schema versions;
- создаёт stable extraction key из `extractorVersion + messageId + episodeOrdinal`;
- повторный запуск той же версии не создаёт дубликаты;
- поддерживает полный recompute новой версией extractor.

Для spike результат может храниться как exact-scope JSONL. Durable pilot implementation использует research-side stores, например:

```text
minutka_research.process_episodes
minutka_research.business_process_candidates
minutka_research.business_process_reviews
minutka_research.business_process_versions
```

### 2.13. Отчёты

Личный отчёт читает owner-safe projection собственных reviewed/candidate process summaries и показывает:

- конкретный процесс;
- число episodes и дат;
- подтверждённый current flow;
- используемые системы;
- ручные шаги и ожидание;
- возможное упрощение;
- явно обозначенные пробелы.

Личный DTO не содержит research IDs, raw quotes и данные других сотрудников.

Client report строится из reviewed business processes и automation recommendations. Activity facets остаются источником coverage и quality diagnostics, но не основным process key.

Client recommendation содержит:

- конкретный business process;
- scope;
- current-state flow;
- systems и data-flow directions;
- наблюдаемую проблему;
- evidence summary;
- process/feasibility/effect confidence;
- automation mechanism;
- human-in-the-loop;
- prerequisites и risks;
- baseline;
- 30/60/90 с owner и exit criteria.

### 2.14. Coverage и quality

Coverage дополняется semantic-quality показателями:

- period start/end;
- extractor/schema/taxonomy versions;
- legacy/new record counts;
- message/activity/trace linkage;
- доля reviewed episodes;
- доля episodes вне cluster;
- missing critical fields;
- доля `other` и omitted systems;
- correction/supersession counts;
- role/function coverage;
- evaluation coverage.

Количественный `usable` не означает, что конкретные processes готовы к рекомендации. Слабые candidates публикуются как investigation questions, а не смешиваются с implementation recommendations.

### Ограничения и принципы

1. **Canonical factual boundary.** Activities остаются factual; derived process interpretation не переписывает их.
2. **Evidence per field.** Значимые process fields имеют origin, confidence и evidence refs.
3. **Human review.** Unreviewed candidate не становится подтверждённым business process или клиентской recommendation.
4. **Tenant isolation.** Process entities и backfill всегда имеют exact company/group scope.
5. **Client boundary.** Компания не получает subject keys, raw messages, traces, activity refs, reviewer notes и identity mapping.
6. **Correction/purge/recompute.** Derived entities инвалидируются или пересчитываются после изменения evidence.
7. **No automation-case leakage into evidence.** Типовой кейс предлагает решение, но не доказывает устройство процесса компании.
8. **Non-blocking discovery.** Ошибка process extraction не ломает durable conversation/activity collection.
9. **Progressive UX.** Сотрудник не проходит полный process interview при каждой фиксации.
10. **Simple infrastructure first.** Git registry, JSONL, typed CLI и ручной review предшествуют vector DB и web-панели.

## 3. Что оставляем / что удаляем

| Существующий элемент | Решение |
|---|---|
| `ActivityTransactionExtractor` | Оставляем узким factual transaction contour |
| Canonical `minutka_private.activities` | Оставляем источником factual activity state |
| Activity facets | Оставляем для activity summary, evidence и quality diagnostics |
| Corrections/revisions/supersession | Оставляем; распространяем invalidation на derived process entities |
| Research corpus/traces/evaluation | Оставляем и используем как вход process discovery |
| `subject_key` | Оставляем только во внутреннем research contour |
| Internal/client DTO boundary | Оставляем; process layer не ослабляет boundary |
| Grouping `taskCategory + routinePattern` как process key | Убираем из роли основного источника client recommendations после переключения report path |
| Generic activity-bucket recommendations | Оставляем временным fallback/diagnostic до process-based report |
| Обязательное заполнение полной process schema в daily turn | Не вводим |
| Перезапись legacy activities новым inference | Не вводим |
| Vector database для automation cases | Не вводим в первой версии |
| Автоматическая публикация unreviewed process report | Не вводим |

## 4. Влияние

RFC расширяет [RFC исследовательского корпуса и клиентской карты автоматизации](./rfc-minutka-research-corpus-and-reporting.md) в части предметной модели между canonical corpus и client report. Privacy, tenant isolation, retention, subject linkage и company delivery boundary остаются без изменений.

После принятия и реализации потребуется синхронное обновление:

- `docs/product/Final_Description.md` — process entities и process-based reports;
- `docs/product/evidence-pack-and-client-report-template.md` — process/data-flow/confidence DTO;
- `docs/runbooks/research-corpus-and-evaluation.md` — backfill и process evaluation;
- `docs/runbooks/company-report-export.md` — reviewed process source и fallback;
- `src/application/company-reporting.ts` — переход с activity buckets на process recommendations;
- personal cycle read model — owner-safe process summaries;
- research export schema — process episodes/candidates/reviews/versions;
- purge/recompute use-cases — derived process contour;
- executable/persistence specs — tenant boundary, evidence linkage, invalidation и client DTO.

Отдельный исполняемый план создаётся эпиком в `br` после решения оператора. RFC не создаёт задачи автоматически.

## 5. Trade-offs

### Выбранный вариант: derived process layer поверх corpus и activities

Преимущества:

- сохраняет заработанную надёжность activity capture;
- позволяет переобработать накопленный corpus;
- отделяет факт от исследовательской интерпретации;
- даёт стабильную identity и version business process;
- поддерживает human review и competing interpretations;
- переводит личный и корпоративный отчёты на конкретный язык процессов;
- позволяет сопоставлять процессы с типовыми automation cases;
- process extraction может развиваться независимо от daily runtime.

Недостатки:

- появляется новый derived store и lifecycle;
- нужны clustering, merge/split и review;
- purge/recompute становится шире;
- требуется отдельная evaluation schema;
- растут стоимость и сложность report generation.

### Отвергнутый вариант A: добавить все process fields в `Activity`

Вариант дешевле на первом шаге, но смешивает factual episode и inferred process, создаёт множество nullable fields и не решает identity/sequence/clustering. Activity correction становится заменой process modeling. Вариант отвергнут.

### Отвергнутый вариант B: заменить activities сущностью `BusinessProcess`

Сотрудник сообщает фрагменты и episodes, а не полную стабильную модель процесса. Вариант делает ежедневный capture зависимым от сложного inference и приводит к дубликатам/ложным объединениям. Вариант отвергнут.

### Отвергнутый вариант C: строить карту только из automation cases

Типовые кейсы ускоряют composition, но создают confirmation bias и не являются evidence компании. Вариант отвергнут как основной источник процессов.

### Отложенный вариант: live process extraction до offline backfill

Live-вопросы без знания реальных missing fields рискуют ухудшить Telegram UX и увеличить стоимость. Сначала выполняются offline spike и evaluation; live enrichment вводится по их результатам.

## 6. Error handling & деградация

### Ошибка `ProcessEpisodeExtractor`

- canonical message и activity сохраняются;
- trace фиксирует bounded failure;
- episode отсутствует или получает visible extraction failure status;
- пользователь не получает ложное подтверждение полного process capture;
- повторный offline backfill может восстановить derived result.

### Ошибка clustering

- episodes сохраняются независимо;
- candidate не публикуется автоматически;
- competing clusters остаются доступны методологу;
- merge/split выполняется через typed review operation.

### Correction или supersession activity

- evidence dependency помечает связанные episodes/candidates stale;
- report path не использует stale reviewed projection без явной limitation;
- typed recompute создаёт новую derived version.

### Purge company/group/subject

- удаляются process episodes и review records выбранного scope либо пересчитываются aggregates без удалённого evidence;
- ещё не переданный client report пересчитывается;
- переданный artifact не заменяется молча.

### Automation case не найден

- process остаётся в каталоге;
- recommendation получает `no_matching_case` или reviewed custom hypothesis;
- отсутствие case не понижает достоверность самого process evidence.

### Слабое evidence

- candidate остаётся investigation question;
- process prevalence не получает `confirmed` от похожего automation case;
- client report явно называет missing fields и способ проверки.

## 7. Не-цели и когда пересмотреть

### Не-цели первой реализации

- полный BPMN 2.0 editor и BPMN engine;
- process mining по системным event logs;
- автоматическое выполнение найденных процессов;
- автоматическая публикация отчёта компании;
- web-панель методолога;
- vector database;
- межкомпанейское обучение на private process records;
- автоматическое слияние процессов разных компаний;
- точная финансовая оценка эффекта без baseline;
- обязательный process interview при каждом daily turn;
- перезапись canonical activity inference-ом из backfill;
- гарантированная готовность описания к production-внедрению без discovery/API/security проверки.

### Когда пересмотреть

- Векторный retrieval пересматривается, когда curated automation catalog становится слишком большим для deterministic filtering и измеримо ухудшается match recall.
- Web review UI пересматривается, когда CLI/JSONL review становится блокером методолога на реальном цикле.
- BPMN export пересматривается, когда минимум несколько reviewed processes используются для внедрения и нужен обмен с process-design tools.
- Live process interview расширяется, когда backfill/evaluation показывает конкретные missing fields с высоким expected information gain и приемлемой пользовательской стоимостью.
- Автоматическая публикация пересматривается только после калибровки process/extraction/feasibility confidence и нескольких вручную проверенных циклов.

## 8. Открытые вопросы

1. Какой минимальный набор process fields обязателен для `BusinessProcessCandidate`, а какой остаётся optional до review?
2. Хранить ли `BusinessProcess` на scope компании, группы или поддерживать оба уровня через explicit provenance?
3. Какой алгоритм clustering использовать в первом spike: deterministic signatures, один LLM-pass или двухэтапный candidate matching?
4. Какая роль подтверждает process: методолог «Алгоритма», process owner компании или оба последовательно?
5. Какие поля reviewed process можно безопасно показывать сотруднику в личном отчёте?
6. Нужна ли отдельная employee confirmation для process label и flow, если вывод используется только в агрегированном client report?
7. Как хранить free-text process fields так, чтобы поддержать purge, evidence linkage и запрет client leakage?
8. Как калибровать четыре confidence axes на первом внешнем цикле?
9. Какие 10–20 automation cases составляют минимальный curated catalog?
10. Должен ли backfill читать полный trace payload или достаточно employee message, active activities и activity-transaction decision?
11. Как обрабатывать process variants: отдельные processes, ветви одного процесса или exception profiles?
12. Какую date/time evidence model использовать для задним числом описанных episodes?
13. Какие quality thresholds блокируют перенос process candidate в client recommendation?
14. Какой формат review удобнее для первого цикла: JSONL + Markdown, typed CLI или генерируемая статическая HTML-страница?
