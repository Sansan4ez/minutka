# Шаблоны evidence pack и клиентской карты автоматизации

## Статус

**accepted template v2 (2026-09-07); принят 2026-08-18 как v1.** Документ задаёт Markdown- и JSON-контракты для ручного первого цикла. Клиентский контракт v2 — «Карта рутин и быстрых улучшений» по [RFC инвентаря рутин и быстрых побед](../architecture/rfc-routine-inventory-and-quick-wins.md) §2.8: рутины из проверенного справочника, бюджет времени, quick wins из закрытого каталога, deep-dive вопросы; без `expectedEffect`, `prerequisites`, `risks` и 30/60/90. `CompanyReportingService` формирует subject-aware internal DTO и отдельный client DTO; методолог по-прежнему вручную проверяет и публикует клиентский артефакт.

> **Статус реализации.** Runtime сейчас отдаёт `minutka-client-report.v1` (структура в git-истории этого файла до 2026-09-07); DTO v2, справочник рутин и `preflightFindings` реализуются эпиком RFC инвентаря рутин. Единственный активный контракт — v2 этого документа.

Шаблоны конкретизируют [RFC исследовательского корпуса и клиентской карты автоматизации §2.7–2.9](../architecture/rfc-minutka-research-corpus-and-reporting.md#27-внутренний-evidence-pack):

- evidence pack — внутренний group-scoped артефакт исследовательской команды;
- client report — отдельный проверенный артефакт для компании;
- confidence показывает силу evidence вместо универсального запрета для групп или срезов меньше пяти участников.

## 1. Два разных артефакта

| Артефакт | Кто использует | Что содержит | Можно передавать компании |
|---|---|---|---|
| Internal evidence pack | исследователь/методолог «Алгоритма» | subject-linked messages, activities, traces, feedback, human labels, версии и coverage | нет |
| Client report / карта рутин и быстрых улучшений | компания-клиент после ручной проверки | рутины из проверенного справочника, бюджет времени, confidence, quick wins из закрытого каталога, deep-dive вопросы | да |

Client report не является «обрезанным evidence pack». Он собирается отдельным DTO и проходит отдельную проверку границы. В него не входят внутренние ключи участника, raw messages, trace payload, identity mapping, исследовательские заметки и персональные оценки.

## 2. Internal evidence pack

### 2.1. JSON DTO

Первый implementation path экспортирует один JSON-файл с метаданными и связанные JSONL-потоки для объёмных коллекций. Поля ниже являются целевым контрактом; точные имена storage records определяет реализация canonical export.

```json
{
  "schemaVersion": "minutka-evidence-pack.v1",
  "generatedAt": "2026-09-18T12:00:00Z",
  "scope": {
    "companyId": "company_acme",
    "groupId": "group_acme_2026_09",
    "periodStart": "2026-09-01",
    "periodEnd": "2026-09-14"
  },
  "coverage": {
    "invitedParticipants": 7,
    "contributingSubjects": 6,
    "activeDates": 10,
    "messageCount": 132,
    "activityCount": 48,
    "traceCount": 65,
    "missingTraceCount": 1,
    "feedbackCount": 9,
    "roleCoverage": [
      {
        "roleId": "role_logistics",
        "roleName": "Логист",
        "invitedParticipants": 2,
        "contributingSubjects": 2
      }
    ],
    "limitations": [
      "Один участник не отвечал после онбординга",
      "Для одного agent run отсутствует trace payload"
    ]
  },
  "subjects": [
    {
      "subjectKey": "subj_7c1f...",
      "roleId": "role_logistics",
      "roleName": "Логист",
      "activeDates": ["2026-09-02", "2026-09-04"],
      "messageCount": 14,
      "activityCount": 6
    }
  ],
  "messages": [
    {
      "messageId": "msg_101",
      "subjectKey": "subj_7c1f...",
      "occurredAt": "2026-09-04T16:22:00Z",
      "direction": "participant_to_assistant",
      "content": "..."
    }
  ],
  "activities": [
    {
      "activityId": "act_301",
      "subjectKey": "subj_7c1f...",
      "activityDate": "2026-09-04",
      "taskCategory": "reporting",
      "system": "spreadsheet",
      "durationBucket": "30_60m",
      "obstacle": "duplicate_entry",
      "sourceMessageIds": ["msg_101"],
      "taxonomyVersion": "activities.v2"
    }
  ],
  "traces": [
    {
      "traceId": "trace_501",
      "subjectKey": "subj_7c1f...",
      "messageId": "msg_101",
      "promptVersion": "evening-reflection.v3",
      "taxonomyVersion": "activities.v2",
      "payload": {}
    }
  ],
  "feedback": [
    {
      "feedbackId": "feedback_701",
      "subjectKey": "subj_7c1f...",
      "messageId": "msg_101",
      "kind": "pattern_confirmed",
      "value": true
    }
  ],
  "humanLabels": [
    {
      "labelId": "label_801",
      "evidenceRefs": ["act_301", "trace_501"],
      "label": "candidate_duplicate_entry",
      "reviewerNote": "Проверить повторяемость между CRM и таблицей"
    }
  ]
}
```

Инварианты evidence DTO:

- `companyId` и `groupId` обязательны; межтенантный пакет не создаётся;
- `subjectKey` связывает evidence, но identity mapping и transport identifiers в пакет не входят;
- raw content и trace payload допустимы только во внутреннем артефакте;
- отсутствующий trace отражается в `missingTraceCount` и limitation, а не скрывается;
- human labels ссылаются на evidence refs, чтобы вывод можно было проверить и пересчитать.

### 2.2. Markdown summary

```markdown
# Evidence pack: <company> / <group> / <period>

## Scope и provenance
- Company ID:
- Group ID:
- Period:
- Schema / prompt / taxonomy versions:
- Generated at:

## Coverage
- Invited participants:
- Contributing subjects:
- Active dates:
- Messages / activities / traces / feedback:
- Missing traces:
- Role and process coverage:
- Limitations:

## Candidate process patterns
### <process name>
- Scope:
- Subjects / observations / dates:
- Systems:
- Evidence refs:
- Supporting interpretation:
- Competing interpretation:
- Current confidence:
- Verification needed:

## Human labels and evaluation candidates
- Evidence refs:
- Label:
- Expected behavior:
- Reviewer notes:

## Draft client recommendations
- Candidate recommendation ID:
- Included evidence refs:
- Redactions/generalizations required before client report:
```

Markdown summary помогает методологу читать пакет, но JSON/JSONL остаётся машинным входом для evaluation и canonical reporting.

## 3. Client report / карта рутин и быстрых улучшений

### 3.1. JSON DTO

Client DTO использует внешние labels и агрегированные evidence summaries. В нём нет поля, через которое можно получить внутреннюю запись участника, raw label или raw evidence. Структура v2 по [RFC инвентаря рутин §2.8](../architecture/rfc-routine-inventory-and-quick-wins.md): семь разделов, quick win из закрытого каталога, deep-dive как мост ко второму этапу.

```json
{
  "schemaVersion": "minutka-client-report.v2",
  "title": "Карта рутин и быстрых улучшений",
  "companyLabel": "Компания ACME",
  "groupLabel": "Пилотная группа, сентябрь 2026",
  "period": { "start": "2026-09-01", "end": "2026-09-14" },
  "coverage": {
    "assessment": "usable_with_limits",
    "invitedParticipants": 9,
    "contributors": 8,
    "activeDates": 15,
    "observations": 386,
    "unsizedObservations": 157,
    "unattributedObservations": 40,
    "coveredRoles": ["продажи", "логистика"],
    "limitations": ["Тендеры и бухгалтерия представлены одним участником; их рутины показаны без роли"]
  },
  "timeBudget": [
    { "taskCategory": "focus_work", "estimatedHours": 47.3, "share": 0.25, "contributors": 7 },
    { "taskCategory": "admin", "estimatedHours": 42.9, "share": 0.23, "contributors": 8 }
  ],
  "topRoutines": [
    {
      "name": "обработка заявок в CRM",
      "scope": "продажи",
      "evidenceSummary": { "contributors": 3, "observations": 21, "activeDates": 9, "estimatedHours": 18.5, "unsizedObservations": 6 },
      "systems": ["crm"],
      "statedRecurrence": { "daily": 2 },
      "confidence": "confirmed",
      "quickWin": {
        "id": "api_integration",
        "title": "Заявки попадают в CRM без ручного переноса",
        "whatChanges": "Форма или коннектор создаёт карточку заявки; менеджер проверяет и дополняет, а не перепечатывает",
        "effort": "days",
        "whoCanDo": "internal_it",
        "humanInTheLoop": "Менеджер подтверждает карточку и разбирает исключения",
        "firstStep": "Собрать список полей, которые переносятся вручную из заявки в CRM"
      }
    },
    {
      "name": "обзвон клиентской воронки",
      "scope": "продажи",
      "evidenceSummary": { "contributors": 3, "observations": 14, "activeDates": 8, "estimatedHours": 12.0, "unsizedObservations": 3 },
      "systems": ["crm", "telephony"],
      "statedRecurrence": {},
      "confidence": "confirmed",
      "deepDive": true,
      "question": "Какие звонки можно заменить письменным касанием, а какие требуют разговора"
    }
  ],
  "frictionRoutines": [
    {
      "name": "уточнение условий закупок",
      "scope": "группа",
      "signals": { "waiting_for_input": 4 },
      "evidenceSummary": { "contributors": 2, "observations": 5, "activeDates": 4 },
      "confidence": "signal",
      "quickWin": { "id": "waiting_sla", "title": "Напоминание по сроку ответа", "whatChanges": "Запрос с датой ожидания и автоматическая эскалация", "effort": "hours", "whoCanDo": "employee", "humanInTheLoop": "Сотрудник решает, когда эскалировать", "firstStep": "Договориться о сроке ответа на уточнение" }
    }
  ],
  "firstSteps": [
    { "routine": "уточнение условий закупок", "firstStep": "Договориться о сроке ответа на уточнение", "effort": "hours", "whoCanDo": "employee" },
    { "routine": "обработка заявок в CRM", "firstStep": "Собрать список полей, которые переносятся вручную из заявки в CRM", "effort": "days", "whoCanDo": "internal_it" }
  ],
  "deepDive": [
    { "name": "обзвон клиентской воронки", "scope": "продажи", "question": "Какие звонки можно заменить письменным касанием, а какие требуют разговора", "reason": "Сложная задача: решение зависит от шагов процесса, которых первый этап не видит" }
  ],
  "cannotConclude": [
    "Точные часы: 41 % наблюдений без длительности, часы — порядок величины по самоотчётам",
    "Эффект и prerequisites быстрых улучшений: требуют обследования процесса (второй этап)"
  ]
}
```

Разрешённые поля рутины:

| Поле | Правило |
|---|---|
| `name` | каноническое имя записи справочника рутин, проверенное методологом; raw label сотрудника — никогда |
| `scope` | группа либо роль, у которой два и более contributors; рутина роли с одним человеком показывается без роли |
| `evidenceSummary` | только агрегаты: contributors, observations, activeDates, ≈часы, unsizedObservations |
| `systems`, `statedRecurrence` | закрытые facets и заявленная частота как сказано, без сверки с наблюдениями |
| `confidence` | `hypothesis`, `signal` или `confirmed` по §4 |
| `quickWin` | строка закрытого каталога RFC §2.7 из записи справочника: `title`, `whatChanges`, `effort`, `whoCanDo`, `humanInTheLoop`, `firstStep` |
| `deepDive`, `question` | рутина без quick win уходит во второй этап как вопрос, не как рекомендация |

Запрещённые поля и содержимое:

- внутренний ключ участника и списки contributors;
- employee/user/participant IDs и identity mapping;
- raw `routineLabel`, `variants`, `routineKey`, evidence refs — только internal DTO;
- роль с одним contributor как scope рутины;
- ≈часы по отдельному сотруднику;
- raw message, transcript, цитата, source message ID;
- trace ID, trace payload, prompt/context/tool-call payload;
- research notes и human-label notes;
- оценка продуктивности, настроения, лояльности или качества работы конкретного человека;
- сочетание редких деталей, служащее фактическим идентификатором автора.

### 3.2. Markdown template

```markdown
# Карта рутин и быстрых улучшений: <company>

## 1. Период и coverage
- Группа / роли:
- Период наблюдения:
- Приглашено / contributors:
- Активные даты / observations:
- Наблюдений без длительности / без объекта работы:
- Пробелы и ограничения:

## 2. Куда уходит время
| Категория | ≈часов за цикл | Доля | Contributors |

## 3. Топ рутин по времени (до 10)
### <name> — <scope> — <confidence>
- **Evidence:** contributors / observations / dates / ≈часов (без длительности: N)
- **Системы, частота со слов сотрудников:**
- **Быстрое улучшение:** <title> — <whatChanges>
- **Усилие / кто может:** hours | days | weeks — employee | internal_it | with_algoritm
- **Остаётся за человеком:**
- **Первый шаг:**
_или_
- **Для углублённого обследования:** <question>

## 4. Что мешает и раздражает (до 5)
### <name> — <сигналы>
- **Evidence:** …
- **Быстрое улучшение / первый шаг:** …

## 5. С чего начать на следующей неделе
1. <routine> — <firstStep> — <effort> — <whoCanDo>
2. …

## 6. Для углублённого обследования
- <name> — <scope>: <question> (<reason>)

## 7. Чего нельзя заключить из этих данных
- …
```

Часы подписываются как «≈ часов за цикл по самоотчётам группы» и не превращаются в ROI или «экономию N часов в год». Prerequisites, риски, ожидаемый эффект и план 30/60/90 в первом этапе не обещаются: они требуют знания процесса и относятся к платному обследованию, мост к которому — раздел 6.

## 4. Confidence и coverage

Уровень выбирается по максимальному выполненному условию стартовой policy из [RFC §2.9](../architecture/rfc-minutka-research-corpus-and-reporting.md#29-confidence-вместо-универсального-правила-5):

| Уровень | Стартовое правило | Формулировка в отчёте |
|---|---|---|
| `hypothesis` | один subject, одна дата или слабая повторяемость | «наблюдение требует интервью или дополнительной проверки» |
| `signal` | не менее двух subjects **или** устойчивая повторяемость процесса у одного subject в несколько дат | «повторяемость видна, но границы и эффект ещё проверяются» |
| `confirmed` | не менее трёх subjects, пяти observations и трёх дат | «паттерн устойчив в данных цикла» |

Пороги стартовые и калибруются после первого внешнего цикла. Изменение policy требует синхронного обновления RFC, DTO/specs и этого шаблона.

Coverage показывается до рекомендаций и описывает:

- сколько участников приглашено и сколько внесло evidence;
- сколько дат, messages, activities и traces покрыто;
- какие функции, роли, системы и процессы представлены;
- где есть missing traces, пропуски периода или одностороннее покрытие;
- какие выводы из-за этого нельзя делать.

Нет универсального правила «если contributors меньше пяти, отчёт запрещён». Недостаток evidence обрабатывается локально:

- слабая, но допустимая process-level идея публикуется как `hypothesis` с проверкой;
- неизвестный эффект не получает выдуманное число;
- пустой участок попадает в `insufficientEvidence`, а не маскируется отсутствием строки;
- при недостаточном coverage весь документ может содержать только coverage, вопросы и план дополнительного исследования без рекомендаций;
- редкая роль не объединяется с несвязанными ролями в искусственный `other`.

Редкая роль может дать гипотезу о процессе. Формулировка не должна утверждать, что единственный сотрудник работает плохо, медленно, нелояльно или «нуждается в автоматизации».

## 5. Примеры калибровки

Примеры демонстрационные: они фиксируют форму вывода, а не утверждают, что такие данные уже собраны.

### 5.1. Whole-group confirmed

- **Рутина:** обработка заявок в CRM.
- **Scope:** продажи (три contributors).
- **Evidence summary:** 3 contributors, 21 observation, 9 active dates, ≈18 часов, 6 наблюдений без длительности.
- **Confidence:** `confirmed`.
- **Быстрое улучшение:** `api_integration` — заявки попадают в CRM без ручного переноса; первый шаг — список полей, которые переносятся вручную.
- **Почему допустимо:** выполнены условия по subjects, observations и dates; имя рутины взято из проверенного справочника; вывод описывает работу, а не людей.

### 5.2. Within-role signal

- **Рутина:** отправка расчётов заказчику.
- **Scope:** продажи (два contributors одной роли).
- **Evidence summary:** 2 contributors, 5 observations, 3 active dates, ≈4 часа.
- **Confidence:** `signal`.
- **Быстрое улучшение:** `ai_assistant_calc` — черновик расчёта по шаблону с проверкой специалистом.
- **Почему не confirmed:** observations и дат достаточно, но для `confirmed` нужны не менее трёх contributors.

Одинаковое имя работы у двух разных ролей не объединяет evidence: при одном contributor в каждой роли это две role-scoped рутины с confidence `hypothesis`, показанные без роли.

### 5.3. Rare-role hypothesis

- **Рутина:** разбор тендерной документации.
- **Scope:** группа (единственный тендерный специалист; роль не называется).
- **Evidence summary:** 1 contributor, 4 observations в 3 даты.
- **Confidence:** `hypothesis`.
- **Для углублённого обследования:** какие требования из документации повторяются от тендера к тендеру и что из них можно извлекать автоматически.
- **Почему допустимо:** рутина названа как вопрос второму этапу, а не как рекомендация; отчёт не оценивает специалиста и не публикует raw label или цитату.

## 6. Ручной review/publish flow

Typed команда формирует canonical internal/client DTO. Все редакторские и publish-шаги ниже остаются ручными.

1. **Сформировать internal draft.** Доверенный оператор выбирает `company_id` и `group_id`; typed export создаёт evidence pack в защищённом operator contour.
2. **Проверить scope и completeness.** Методолог сверяет tenant/group, coverage, missing traces, версии prompt/taxonomy и evidence refs. Scope mismatch прекращает подготовку целиком.
3. **Разметить выводы.** Методолог записывает supporting/competing interpretations, confidence и необходимые проверки. Генератор не повышает confidence вручную сформулированным текстом.
4. **Собрать client draft отдельным DTO.** Внешний документ создаётся из process-level summaries; копирование raw фрагментов из evidence pack запрещено.
5. **Выполнить boundary preflight.** Структурную часть закрывает схема client DTO; содержательную — `preflightFindings[]` команды отчёта (lint имён рутин, LLM-флаг редких идентифицирующих деталей, assertions policy: rare-role, confidence, coverage, `unnamed_routine`). Методолог читает список находок; находка `severity = high` без его решения блокирует publish (`unresolved_high_findings`), решение по каждой находке пишется в audit. Ничего не вырезается автоматически.
6. **Редакторская проверка.** Методолог проверяет имена рутин, назначения quick win и первые шаги у рутин, попавших в клиентский отчёт, и формулировки deep-dive вопросов. Для каждого пункта должна сохраняться внутренняя evidence linkage, не входящая в клиентский файл.
7. **Зафиксировать решение о передаче.** Оператор записывает версию артефакта, проверяющего, дату, согласованный канал и действующее решение о месте/сроке хранения. Пока отдельная retention policy не принята, нельзя обещать автоматический TTL.
8. **Опубликовать вручную.** Оператор передаёт только финальный client artifact через согласованный канал. Evidence pack, промежуточные drafts и research export не прикладываются.
9. **Сохранить audit metadata.** Фиксируются report version, company/group scope, reviewer и время передачи без копирования payload в audit log.

Автоматическая отправка компании, company dashboard и прямой доступ к report API не входят в пилотный flow.

## 7. Вход для canonical reporting

Реализация `mnt-cycle-completion-4gd.9` использовала v1 этого документа как контракт; DTO v2 (`routines`, `timeBudget`, quick wins, `preflightFindings`, справочник рутин) реализует эпик RFC инвентаря рутин. Общие требования:

- internal DTO сохраняет subject-linked evidence refs и unique contributor semantics;
- client DTO реализуется отдельным типом и проверяется на отсутствие запрещённых полей;
- confidence рассчитывается из canonical activities/subjects/dates по §4;
- report recompute читает актуальный corpus после correction или purge;
- executable specs покрывают три примера §5 и tenant isolation;
- report path читает только canonical subject-aware activities; отдельной anonymized activity copy нет.
