# Паттерн: исследовательский корпус и граница клиентского результата

## Статус

**reference (2026-08-18).** Переиспользуемый архитектурный паттерн для продуктов, которые собирают разговоры или рабочие наблюдения, используют их для ручного исследования и evaluation, а внешнему заказчику передают подготовленный аналитический результат. Конкретные продукты принимают паттерн отдельным RFC и определяют собственные роли, сроки, consent и формат результата.

Related:

- [RFC применения паттерна в «Минутке»](./rfc-minutka-research-corpus-and-reporting.md)
- [Продуктовый baseline «Минутки»](../product/Final_Description.md)

---

## 1. Контекст и область применения

Паттерн применяется, когда продукт одновременно решает три задачи:

1. ведёт полезный диалог с прямым пользователем и сохраняет историю взаимодействия;
2. превращает разговоры в исследовательский корпус для ручного анализа, улучшения промптов/таксономии и evaluation;
3. готовит для внешнего заказчика выводы, рекомендации или другой производный артефакт, но не открывает ему исходный корпус.

Типичные примеры:

- диагностика рабочих процессов и карта автоматизации;
- интервью пользователей и продуктовые рекомендации;
- исследовательские дневники;
- сервис сопровождения обучения;
- внутренние knowledge/research assistants с внешним отчётом.

Проблема возникает, если систему преждевременно проектируют так, будто каждая внутренняя запись уже должна быть безопасна для внешнего заказчика. Тогда теряются связи между наблюдениями, невозможны пересчёт и удаление вклада участника, а анализ опирается на обеднённые копии данных. Обратная крайность — дать заказчику доступ к тем же данным и интерфейсам, которыми пользуется исследователь.

Паттерн проводит границу иначе:

> Внутренний исследовательский корпус сохраняет необходимую доказательную полноту. Внешний заказчик получает отдельный подготовленный результат с собственным контрактом видимости.

## 2. Цели

- Сохранить контекст, достаточный для качественного исследования и воспроизводимой отладки.
- Связать разговор, структурированные наблюдения, execution trace, feedback и evaluation без прямого использования имени участника.
- Отличать распространённый сигнал от многократных сообщений одного активного участника.
- Поддерживать исправление классификации, пересчёт аналитики и удаление/санитизацию вклада участника.
- Формировать внешний результат из канонических данных без отдельной необратимой обезличенной копии.
- Не смешивать operational logs, research traces, canonical corpus и client deliverable.
- Оставить простой путь пилота: PostgreSQL/JSONB, typed CLI и ручная редакторская проверка вместо преждевременной платформы RBAC/BI.

## 3. Не-цели

- Не универсальная юридическая политика: правовые основания и формулировки consent задаёт продукт.
- Не автоматическая публикация результата заказчику.
- Не обязательное fine-tuning или обучение модели на корпусе.
- Не бесконечное хранение по умолчанию: пилот может временно не иметь автоматического TTL, но должен сохранять возможность выборочного удаления.
- Не замена технических метрик и логов полным corpus storage.
- Не обязательная отдельная физическая БД для каждого контура; логическое разделение и разные контракты обязательны, физическое — решение реализации.

## 4. Основная модель

Система хранит четыре канонических вида данных.

| Сущность | Отвечает на вопрос | Типичное содержимое |
|---|---|---|
| `messages` | Что происходило в разговоре? | сообщение пользователя, ответ агента, время, thread |
| `activities` / `observations` | Какие предметные сигналы выделены? | категория, система, длительность, препятствие, ссылка на evidence |
| `traces` | Как система пришла к результату? | prompt/context version, model steps, tool calls, output, error, latency, usage |
| `reports` | Что получает внешний заказчик? | рекомендации, evidence summary, confidence, ожидаемый эффект, план действий |

Связь первых трёх сущностей строится через непрозрачный псевдоним `subject_key`. Четвёртая сущность не содержит `subject_key`, исходных сообщений и trace payload.

```text
User interaction
  │
  ├── messages ───────────────┐
  ├── structured observations ├──► internal evidence/evaluation
  ├── execution traces ───────┘
  │
  └── reviewed transformation ───► client deliverable
```

## 5. `subject_key`

### 5.1. Назначение

`subject_key` — случайный непрозрачный идентификатор исследуемого участника. Он позволяет:

- считать уникальных contributors;
- видеть повторяемость у одного участника во времени;
- отличать индивидуальный сигнал от межсубъектного;
- связать conversation, activity, trace и feedback;
- пересчитать аналитику после исправления;
- найти данные для удаления или санитизации;
- собирать evaluation cases без имени и transport identifiers.

### 5.2. Инварианты

- Ключ генерируется случайно, а не вычисляется из имени, телефона, email или transport ID.
- Ключ не является credential и не используется для аутентификации.
- Ключ не попадает во внешний отчёт.
- Identity mapping хранится отдельно от исследовательских проекций.
- По умолчанию ключ ограничен одним исследовательским циклом или группой; межцикловое связывание требует отдельного решения.
- Удаление identity mapping не должно делать сами research records ненайденными для последующей санитизации: records индексируются по `subject_key` непосредственно.

## 6. Канонический корпус

### 6.1. Разговоры

Conversation store остаётся источником истины для пары «вход пользователя → ответ системы». Он не заменяется trace store: trace может не записаться из-за сбоя, а пользовательский разговор должен сохраниться.

Минимальные связи:

- `company_id` / tenant scope;
- `group_id` / research cycle;
- `subject_key` через проекцию или прямое поле;
- `thread_id`;
- `message_id`;
- timestamp;
- user input;
- assistant output.

### 6.2. Структурированные наблюдения

Наблюдение хранится один раз в каноническом store. Отдельная обеднённая копия «для отчёта» не создаётся, если её единственная цель — скрыть participant link.

Наблюдение желательно связывать с:

- `subject_key`;
- `source_message_id` или массивом evidence refs;
- версией таксономии;
- временем наблюдения;
- confidence классификации;
- reviewer correction, если она появилась.

Клиентская агрегация читает этот store через отдельный application use-case и возвращает ограниченный DTO.

## 7. Полные execution traces

### 7.1. Зачем хранить

Trace нужен, чтобы восстановить не только ответ, но и путь к нему:

- какой process и prompt version использовались;
- какой bounded context видел агент;
- какие model steps выполнялись;
- какие инструменты были вызваны;
- какие аргументы и результаты прошли через tools;
- где возникли ошибка, таймаут или неверная классификация;
- как изменилось поведение после обновления prompt/taxonomy/model.

Это основной материал для debugging и evaluation. Его потеря снижает скорость развития продукта.

### 7.2. Trace contract

Минимальная форма:

```ts
type ResearchTrace = {
  schemaVersion: string;
  traceId: string;
  requestId: string;
  messageId?: string;
  companyId: string;
  groupId: string;
  subjectKey: string;
  processIds: string[];
  promptVersion: string;
  taxonomyVersion: string;
  model: string;
  input: unknown;
  context: unknown;
  modelSteps: unknown[];
  toolCalls: unknown[];
  output?: unknown;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    estimatedCost?: number;
  };
  startedAt: string;
  completedAt?: string;
  status: "running" | "completed" | "failed";
  error?: { code: string; message: string };
};
```

### 7.3. Хранение и экспорт

Для пилота достаточно self-hosted PostgreSQL/JSONB или совместимого storage adapter. Обязательны:

- 100% sampling исследовательских agent runs, пока объём мал;
- индексы по tenant/group/subject/request/message;
- `schemaVersion`;
- связь с prompt/taxonomy version;
- возможность JSON/JSONL export;
- отсутствие credentials, auth headers, API keys, invite secrets и database secrets;
- видимый `trace_missing`/drop signal, если exporter не сохранил trace.

Полные traces не следует сводить к неструктурированному stdout: такой поток плохо индексируется, трудно удаляется и неудобен для evaluation.

### 7.4. Operational telemetry остаётся отдельной

Обычные logs/metrics отвечают за эксплуатацию:

- latency;
- error rate;
- availability;
- token/cost counters;
- queue/delivery status;
- dropped trace count.

Они могут ссылаться на `trace_id`, но не обязаны дублировать весь prompt и conversation. Это уменьшает шум и сохраняет corpus в одном управляемом месте.

## 8. Внутренний evidence pack

Внутренняя исследовательская проекция объединяет:

- conversation turns;
- structured observations;
- subject-level frequency;
- dates and systems;
- feedback;
- trace links;
- human labels and notes;
- taxonomy/prompt versions.

Evidence pack нужен для:

1. ручного анализа предметной области;
2. улучшения промптов;
3. изменения таксономии;
4. подготовки evaluation dataset;
5. проверки клиентской рекомендации перед публикацией.

Это не клиентский документ и не должен автоматически публиковаться наружу.

## 9. Клиентский результат

Внешняя сторона получает отдельный артефакт, а не урезанный доступ к research store.

Рекомендуемая карточка вывода:

| Поле | Смысл |
|---|---|
| `process` | процесс или рутина, а не человек |
| `scope` | функция, отдел, должность или вся группа |
| `problem` | наблюдаемая потеря времени/качества/скорости |
| `systems` | задействованные системы |
| `evidenceSummary` | число contributors, повторений и дат без subject keys |
| `confidence` | `hypothesis`, `signal`, `confirmed` |
| `automationOption` | полная или частичная автоматизация |
| `humanInTheLoop` | роль сотрудника после автоматизации |
| `expectedEffect` | ожидаемый бизнес-эффект |
| `prerequisites` | данные, API, регламент, владелец процесса |
| `risks` | ошибки, изменения процесса, adoption |
| `nextSteps` | проверка и план 30/60/90 дней |

Компания не получает:

- `subject_key`;
- identity mapping;
- raw conversation;
- полный trace;
- персональную оценку сотрудника;
- прямой доступ к research UI/API;
- цитату или сочетание деталей, выбранное для идентификации автора.

## 10. Confidence вместо универсального privacy threshold

Количество contributors остаётся важным, но не обязано быть универсальным запретом публикации. Оно показывает силу evidence.

Стартовая калибровка:

- `hypothesis` — один источник или недостаточно повторений/дат;
- `signal` — не менее двух subjects либо повторяемость одного процесса в несколько дат;
- `confirmed` — несколько subjects, повторения и временная устойчивость.

Точные пороги задаёт продукт после первого цикла. Для редкой должности допустима конкретная гипотеза автоматизации, если формулировка описывает процесс и требует проверки, а не оценивает человека.

Передача отдельных participation facts заказчику — самостоятельная продуктовая политика и не выводится автоматически из этого паттерна.

## 11. Доступ

Для закрытого пилота достаточно двух контуров:

1. **Внутренняя исследовательская команда** — corpus, observations, traces, feedback и evidence pack.
2. **Внешний заказчик** — только подготовленный report artifact.

Сложная RBAC не обязательна, пока команда мала и доверена. Минимальные ограничения:

- tenant-scoped typed query/export;
- явный выбор company/group;
- отсутствие employee-facing tools для cross-owner research reads;
- audit факта research export/access без копирования payload в audit metadata;
- company report DTO не содержит research identifiers и raw evidence.

## 12. Retention и удаление

Если пилот ещё не показал полезность разных классов данных, допустимо временно не задавать автоматический TTL. При этом архитектура обязана сохранять управляемость:

- purge по company;
- purge по group/research cycle;
- purge или sanitize по `subject_key`;
- индексация traces и observations по subject;
- versioned structured records;
- отсутствие единственной копии corpus в внешней log-платформе.

После пилота вводится sanitizer с режимами:

- `delete` — удалить record/trace;
- `redact` — удалить выбранные поля;
- `replace` — заменить прямые identifiers placeholders;
- `snapshot` — создать sanitized immutable evaluation case.

Сроки хранения определяются после появления фактических сценариев повторного анализа и объёма данных.

## 13. Evaluation

Evaluation case ссылается на trace/corpus, но является отдельной сущностью:

```ts
type EvaluationCase = {
  caseId: string;
  traceId: string;
  subjectKey: string;
  promptVersion: string;
  taxonomyVersion: string;
  expected?: unknown;
  labels: {
    useful?: boolean;
    accurate?: boolean;
    askedNecessaryQuestion?: boolean;
    extractionCorrect?: boolean;
    toneAccepted?: boolean;
  };
  notes?: string;
};
```

Корпус может использоваться для:

- ручного анализа;
- prompt improvement;
- taxonomy improvement;
- offline/online evaluation.

Fine-tuning/model training не следует подразумевать автоматически: это отдельная цель и отдельное решение.

## 14. Ошибки и деградация

- Conversation turn является durable product data и не теряется из-за сбоя trace exporter.
- Trace failure создаёт технически видимый drop/missing marker; ответ пользователю не откатывается только из-за observability failure.
- Ошибка structured observation не должна маскироваться как успешный сбор: пользовательский ответ может сохраниться, а activity collection получает явный статус.
- Report generator не публикует автоматически слабый или пустой результат: возвращает coverage/confidence и оставляет методологу редакторскую проверку.
- Ошибка tenant scope прекращает export/report целиком; смешанный межтенантный артефакт не создаётся.

## 15. Красные линии паттерна

1. Tenant isolation: corpus одной организации не попадает в исследование или результат другой.
2. Client delivery boundary: внешняя сторона не получает raw corpus, traces, subject keys и identity mapping.
3. Typed writes/reads: агент и отчётность работают через application use-cases.
4. Durable corpus: conversation и предметные observations не теряются тихо.
5. Secret isolation: credentials не попадают в model context, corpus, traces, logs и Git.
6. Reversibility: records остаются находимыми для purge/sanitize/recompute.

Не являются универсальными красными линиями:

- отсутствие cross-owner research reader;
- отсутствие pseudonymous key;
- обязательная анонимизация при записи;
- единый порог contributors для любого вывода;
- запрет пересчёта;
- запрет полного input/output в управляемом research trace.

## 16. Этапы внедрения

1. Зафиксировать продуктовую границу и цели использования corpus.
2. Добавить `subject_key` и tenant-scoped research identity projection.
3. Добавить full trace persistence и trace-drop monitoring.
4. Добавить evidence/evaluation export.
5. Переключить аналитику на canonical observations и subject-aware confidence.
6. Сформировать отдельный client DTO/template.
7. Удалить дублирующий anonymized dual-write после переключения читателей.
8. После пилота добавить sanitizer и calibrated retention.

## 17. Критерии принятия паттерна продуктом

Продуктовый RFC, который ссылается на этот документ, должен определить:

- кто входит во внутреннюю исследовательскую команду;
- tenant/group/subject scope;
- какие данные входят в corpus и traces;
- для каких целей используется corpus;
- используется ли он для model training;
- формат client deliverable;
- стартовую шкалу confidence;
- пилотную retention policy;
- purge/sanitize операции;
- конкретные executable specs на tenant isolation и client DTO boundary.
