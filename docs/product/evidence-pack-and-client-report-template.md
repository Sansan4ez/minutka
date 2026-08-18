# Шаблоны evidence pack и клиентской карты автоматизации

## Статус

**accepted template (2026-08-18), canonical DTO реализован.** Документ задаёт Markdown- и JSON-контракты для ручного первого цикла. `CompanyReportingService` формирует subject-aware internal DTO и отдельный client DTO; методолог по-прежнему вручную проверяет, дополняет и публикует клиентский артефакт.

Шаблоны конкретизируют [RFC исследовательского корпуса и клиентской карты автоматизации §2.7–2.9](../architecture/rfc-minutka-research-corpus-and-reporting.md#27-внутренний-evidence-pack):

- evidence pack — внутренний group-scoped артефакт исследовательской команды;
- client report — отдельный проверенный артефакт для компании;
- confidence показывает силу evidence вместо универсального запрета для групп или срезов меньше пяти участников.

## 1. Два разных артефакта

| Артефакт | Кто использует | Что содержит | Можно передавать компании |
|---|---|---|---|
| Internal evidence pack | исследователь/методолог «Алгоритма» | subject-linked messages, activities, traces, feedback, human labels, версии и coverage | нет |
| Client report / карта автоматизации | компания-клиент после ручной проверки | process-level summaries, confidence, варианты автоматизации, риски и 30/60/90 | да |

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

## 3. Client report / карта автоматизации

### 3.1. JSON DTO

Client DTO использует внешние labels и агрегированные evidence summaries. В нём нет поля, через которое можно получить внутреннюю запись участника или raw evidence.

```json
{
  "schemaVersion": "minutka-client-report.v1",
  "title": "Карта возможностей автоматизации",
  "companyLabel": "Компания ACME",
  "groupLabel": "Пилотная группа, сентябрь 2026",
  "period": {
    "start": "2026-09-01",
    "end": "2026-09-14"
  },
  "coverage": {
    "assessment": "usable_with_limits",
    "invitedParticipants": 7,
    "contributors": 6,
    "activeDates": 10,
    "observations": 48,
    "coveredFunctions": ["логистика", "продажи", "тендеры", "управление"],
    "limitations": ["Телемаркетинг представлен одним участником; вывод по функции требует интервью"]
  },
  "recommendations": [
    {
      "recommendationId": "rec-01",
      "process": "Перенос статусов заказов в сводную таблицу",
      "scope": "Вся группа; процессы логистики и продаж",
      "problem": "Статусы повторно переносятся между рабочими системами и таблицами",
      "systems": ["CRM", "электронные таблицы"],
      "evidenceSummary": {
        "contributors": 4,
        "observations": 8,
        "activeDates": 4,
        "summary": "Повторный ввод встречается в нескольких функциях и сохраняется в течение цикла",
        "limitations": []
      },
      "confidence": "confirmed",
      "automationOption": "Синхронизировать статусы по API и оставить ручную проверку исключений",
      "humanInTheLoop": "Владелец процесса проверяет спорные статусы и подтверждает исправления",
      "expectedEffect": "Сокращение повторного ввода и расхождений в статусах",
      "prerequisites": ["владелец процесса", "доступность CRM API", "единый справочник статусов"],
      "risks": ["несовпадение статусов систем", "ошибочная обработка исключений"],
      "nextSteps": {
        "day30": {
          "objective": "Подтвердить процесс и baseline",
          "actions": ["описать переходы статусов", "замерить объём повторного ввода"],
          "owner": "владелец процесса",
          "exitCriteria": ["согласована схема статусов", "выбран пилотный участок"]
        },
        "day60": {
          "objective": "Проверить решение на ограниченном участке",
          "actions": ["собрать прототип интеграции", "вести журнал исключений"],
          "owner": "IT и владелец процесса",
          "exitCriteria": ["прототип работает на тестовых данных", "исключения разобраны"]
        },
        "day90": {
          "objective": "Принять решение о внедрении",
          "actions": ["сравнить baseline и пилот", "утвердить регламент human-in-the-loop"],
          "owner": "спонсор и владелец процесса",
          "exitCriteria": ["эффект подтверждён или гипотеза закрыта", "есть решение о rollout"]
        }
      }
    }
  ],
  "insufficientEvidence": [
    {
      "scope": "Телемаркетинг",
      "question": "Автоматизация первичной классификации звонков",
      "reason": "Наблюдение получено от одного contributor и не повторилось в нескольких датах",
      "allowedConclusion": "Гипотеза для отдельного интервью, не подтверждённый вывод"
    }
  ]
}
```

Разрешённые поля рекомендации:

| Поле | Правило |
|---|---|
| `process` | описывает процесс или рутину, не человека |
| `scope` | вся группа, функция, отдел или точная должность, когда это полезно и не является персональной оценкой |
| `problem` | наблюдаемая потеря времени, качества или скорости |
| `systems` | бизнес-системы и каналы процесса |
| `evidenceSummary` | только агрегированное число contributors, observations, dates, краткое обобщение и ограничения |
| `confidence` | `hypothesis`, `signal` или `confirmed` |
| `automationOption` | полная или частичная автоматизация / AI-assistance |
| `humanInTheLoop` | решение, проверка или исключения, остающиеся у человека |
| `expectedEffect` | проверяемая гипотеза эффекта без выдуманной точности |
| `prerequisites` | владелец, данные, API, регламент, baseline |
| `risks` | ошибки, adoption, безопасность и изменение процесса |
| `nextSteps` | структурированный план 30/60/90 |

Запрещённые поля и содержимое:

- внутренний ключ участника и списки contributors;
- employee/user/participant IDs и identity mapping;
- raw message, transcript, цитата, source message ID;
- trace ID, trace payload, prompt/context/tool-call payload;
- research notes и human-label notes;
- оценка продуктивности, настроения, лояльности или качества работы конкретного человека;
- сочетание редких деталей, служащее фактическим идентификатором автора.

### 3.2. Markdown template

```markdown
# Карта возможностей автоматизации: <company>

## Период и scope
- Группа / функции:
- Период наблюдения:
- Дата ручной проверки:

## Coverage и ограничения
- Приглашено / contributors:
- Активные даты / observations:
- Покрытые функции и процессы:
- Пробелы и ограничения:
- Что нельзя заключить из этих данных:

## Приоритеты
1. <process — confidence — ожидаемый эффект>
2. ...

## Рекомендации
### <process>
- **Scope:**
- **Problem:**
- **Systems:**
- **Evidence summary:** contributors / observations / dates / summary / limitations
- **Confidence:** hypothesis | signal | confirmed
- **Automation option:**
- **Human in the loop:**
- **Expected effect:**
- **Prerequisites:**
- **Risks:**

#### 30 дней
- Objective:
- Actions:
- Owner:
- Exit criteria:

#### 60 дней
- Objective:
- Actions:
- Owner:
- Exit criteria:

#### 90 дней
- Objective:
- Actions:
- Owner:
- Exit criteria:

## Недостаточно evidence
- Scope / вопрос:
- Чего не хватает:
- Допустимый вывод:
- Как проверить:
```

30/60/90 — не три обещания результата. Каждая фаза содержит цель, действия, ответственного и проверяемые exit criteria: первые 30 дней подтверждают процесс и baseline, 60 дней проверяют ограниченный прототип, 90 дней сравнивают эффект и принимают решение о rollout или закрытии гипотезы.

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

- **Process:** ручной перенос статусов в сводную таблицу.
- **Scope:** вся группа, несколько функций.
- **Evidence summary:** 4 contributors, 8 observations, 4 active dates; CRM и таблицы повторяются в разных рабочих контекстах.
- **Confidence:** `confirmed`.
- **Automation option:** API-синхронизация статусов с ручной очередью исключений.
- **Почему допустимо:** выполнены стартовые условия по subjects, observations и dates; вывод описывает общий процесс, а не участников.

### 5.2. Cross-role signal

- **Process:** повторная подготовка одинаковых данных для передачи между продажами и логистикой.
- **Scope:** две функции.
- **Evidence summary:** 2 contributors из разных ролей, 3 observations, 2 active dates; граница процесса подтверждена не полностью.
- **Confidence:** `signal`.
- **Automation option:** единая форма передачи и автоматическое заполнение общих полей.
- **Почему не confirmed:** есть межсубъектная повторяемость, но недостаточно observations и временной устойчивости.

### 5.3. Rare-role hypothesis

- **Process:** первичная классификация требований тендерной документации.
- **Scope:** функция тендеров, представленная одной редкой ролью.
- **Evidence summary:** 1 contributor, 2 observations в одну дату; требуется интервью и просмотр неперсонального примера документа.
- **Confidence:** `hypothesis`.
- **Automation option:** прототип извлечения требований с обязательной проверкой специалистом.
- **Почему допустимо:** отчёт предлагает проверить автоматизацию процесса и явно показывает слабое evidence; он не оценивает специалиста и не публикует raw quote.

## 6. Ручной review/publish flow

Typed команда формирует canonical internal/client DTO. Все редакторские и publish-шаги ниже остаются ручными.

1. **Сформировать internal draft.** Доверенный оператор выбирает `company_id` и `group_id`; typed export создаёт evidence pack в защищённом operator contour.
2. **Проверить scope и completeness.** Методолог сверяет tenant/group, coverage, missing traces, версии prompt/taxonomy и evidence refs. Scope mismatch прекращает подготовку целиком.
3. **Разметить выводы.** Методолог записывает supporting/competing interpretations, confidence и необходимые проверки. Генератор не повышает confidence вручную сформулированным текстом.
4. **Собрать client draft отдельным DTO.** Внешний документ создаётся из process-level summaries; копирование raw фрагментов из evidence pack запрещено.
5. **Выполнить boundary preflight.** Проверяются запрещённые поля и содержимое, редкие идентифицирующие детали, персональные оценки, корректность coverage/confidence и наличие human-in-the-loop.
6. **Редакторская проверка.** Методолог редактирует рекомендации, риски, prerequisites и 30/60/90. Для каждого пункта должна сохраняться внутренняя evidence linkage, не входящая в клиентский файл.
7. **Зафиксировать решение о передаче.** Оператор записывает версию артефакта, проверяющего, дату, согласованный канал и действующее решение о месте/сроке хранения. Пока отдельная retention policy не принята, нельзя обещать автоматический TTL.
8. **Опубликовать вручную.** Оператор передаёт только финальный client artifact через согласованный канал. Evidence pack, промежуточные drafts и research export не прикладываются.
9. **Сохранить audit metadata.** Фиксируются report version, company/group scope, reviewer и время передачи без копирования payload в audit log.

Автоматическая отправка компании, company dashboard и прямой доступ к report API не входят в пилотный flow.

## 7. Вход для canonical reporting

Реализация `mnt-cycle-completion-4gd.9` использует этот документ как контракт:

- internal DTO сохраняет subject-linked evidence refs и unique contributor semantics;
- client DTO реализуется отдельным типом и проверяется на отсутствие запрещённых полей;
- confidence рассчитывается из canonical activities/subjects/dates по §4;
- report recompute читает актуальный corpus после correction или purge;
- executable specs покрывают три примера §5 и tenant isolation;
- legacy `anonymized_activities` не читается canonical report path и удаляется отдельной cleanup-задачей.
