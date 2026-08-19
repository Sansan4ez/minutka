# RFC: исследовательский корпус и клиентская карта автоматизации «Минутки»

## Status

**accepted (2026-08-18), до первого внешнего пилота.** RFC применяет [переиспользуемый паттерн исследовательского корпуса](./research-corpus-reporting-pattern.md) к «Минутке» и заменяет прежнее решение об обезличенном dual-write, универсальном правиле ≥5 и retention «до отчёта». Модель тенантности company → training group → participant → role сохраняется.

> [RFC мультитенантного контура и обезличенной отчётности](./rfc-minutka-tenancy-and-reporting.md) получает статус `superseded` в части reporting/privacy §§2.2–2.6, §5 и связанных не-целей. Его решения о справочниках, инвайтах, tenant isolation, structured activity contract и диалоге сбора остаются провенансом до переноса в код и документацию.

Related:

- [Паттерн исследовательского корпуса](./research-corpus-reporting-pattern.md)
- [Продуктовый baseline](../product/Final_Description.md)
- [Продуктовый бриф](../product/agent-minutka-brief.md)
- [RFC планки качества пилота](./rfc-pilot-quality-bar.md)
- [RFC унаследованного agent-led runtime](./rfc-agent-led-routing.md)

---

## 1. Проблема

Цель B2B-продукта — не сама ежедневная рефлексия, а доказательная карта автоматизации предприятия: конкретные процессы, рутины, системы, препятствия и варианты полной или частичной передачи работы AI-агентам. Помощник сотрудника обеспечивает регулярность, уточнение и непосредственную пользу участнику, но компания платит за качественный аналитический результат.

Принятый ранее контур обедняет данные в момент записи:

- `minutka_private.activities` сохраняет participant link;
- `minutka_reporting.anonymized_activities` дублирует активность без participant link;
- company report читает вторую таблицу;
- связь с источником, пересчёт и subject-level coverage теряются по построению;
- один активный сотрудник неотличим от нескольких contributors;
- удаление/исправление вклада невозможно;
- методолог не имеет доступа к разговорам и execution traces, хотя они нужны для ручного анализа, prompt/taxonomy improvement и evaluation;
- универсальное правило ≥5 скрывает полезные гипотезы по редким должностям в малой группе.

Поскольку внешних участников ещё не было и существуют только внутренние тестовые данные команды, продукт может заменить решение до первого фактического consent без пользовательской миграции обязательств.

## 2. Решение

Ключевая граница проходит не между «данными сотрудника» и всей командой продукта, а между внутренним исследовательским контуром «Алгоритма» и компанией-клиентом:

> Команда «Алгоритма» хранит и анализирует полный псевдонимизированный корпус. Компания получает только подготовленную методологом карту автоматизации без raw corpus, traces, subject keys и персональных оценок.

### 2.1. Ценность и роли

- **Сотрудник** ежедневно рассказывает о работе и получает AI-помощника для планирования, рефлексии и упрощения собственной рутины. Его `typicalTasks`, `aiLevel` и `programGoal` — отдельный employee-only profile context: они помогают персонализировать bounded LLM context, но не являются structured research observations и не входят в participant inventory или company report.
- **Исследователь/методолог «Алгоритма»** имеет доступ к corpus, structured activities, traces и feedback в пределах выбранной компании/группы; выполняет ручной анализ, улучшает промпты и таксономию, размечает evaluation cases и готовит отчёт.
- **Оператор участия** заводит справочники, инвайты и сопровождает группу. На пилоте это может быть тот же доверенный человек, что и исследователь; права не требуют отдельной RBAC-роли до расширения команды.
- **Компания-клиент** не имеет product account/API/DB/trace-viewer доступа и получает только проверенный report artifact.

### 2.2. Тенантность сохраняется

Сохраняются справочники:

- `companies`;
- `training_groups`;
- per-company `roles`;
- participant binding к company/group/role;
- точные роли без искусственного укрупнения ради privacy threshold.

Все research reads и exports требуют явный `company_id` и `group_id`. Данные компании A не входят в corpus export, evaluation dataset или отчёт компании B.

### 2.3. Псевдонимизированный `subject_key`

При создании participant система генерирует случайный group-scoped `subject_key`.

Инварианты:

- не вычисляется из имени или Telegram identifiers;
- не используется как credential;
- индексируется в research records;
- образует с `company_id` и `group_id` неразрывный tuple: composite-ключи схемы отвергают canonical activity, message, trace и evaluation case, у которых subject не принадлежит указанным company/group;
- не попадает в company report;
- позволяет считать unique contributors, связывать evidence и выполнять purge/sanitize/recompute;
- новая программа по умолчанию создаёт новый key, даже если участвует тот же человек.

Identity binding остаётся в private participant contour. Research DTO показывает `subject_key`, роль, группу и evidence, но не ФИО, телефон и transport identifiers, если конкретная support-операция не требует иного.

### 2.4. Канонические данные вместо dual-write

Канонические сущности:

1. `minutka_private.messages` — разговор сотрудника и агента;
2. `minutka_private.activities` — structured activities/observations;
3. `minutka_research.traces` — full execution traces;
4. `minutka_research.evaluation_cases` или эквивалентная typed проекция — разметка evaluation;
5. report artifact — отдельный производный результат.

`minutka_reporting.anonymized_activities` и `AnonymizedActivityRecord` удаляются после переключения всех report readers. `CollectActivityService` сохраняет одну каноническую activity, связанную с subject и source message/evidence. Отдельная необратимая строка «без связи» не создаётся.

Изменение выполняется в два безопасных шага:

1. добавить новые readers/traces/subject-aware report поверх canonical stores;
2. только после зелёных specs удалить old dual-write, table, retention commands и старые assertions.

### 2.5. Full execution traces

Для всех пилотных agent runs действует sampling 100%. Trace включает:

- `trace_id`, `request_id`, `message_id`;
- `company_id`, `group_id`, `subject_key`;
- process ids;
- prompt/process/taxonomy version;
- model и параметры, безопасные для хранения;
- agent input и фактически собранный bounded context;
- model steps;
- tool calls и результаты;
- output;
- error, latency и usage.

Secrets, credentials, auth headers, invite codes и infrastructure tokens исключаются. Встроенный secret filter Mastra сохраняется. PII-redaction для research trace не включается до отдельного post-pilot sanitizer: содержание разговора является целевой частью корпуса.

Пилотный store — self-hosted PostgreSQL/JSONB или Mastra storage adapter поверх self-hosted хранилища. Внешняя hosted observability платформа не становится единственной копией corpus.

Trace failure не откатывает сохранённый conversation turn. Система фиксирует `trace_missing`/drop signal, чтобы отсутствие evidence было видно.

### 2.6. Цели использования корпуса

Корпус используется для:

1. ручного анализа рабочих процессов;
2. улучшения prompt/process instructions;
3. улучшения закрытых словарей и таксономии;
4. evaluation текущих и новых версий.

Fine-tuning и model training не входят в текущую цель и не подразумеваются формулировкой «улучшение продукта». Их включение требует отдельной ревизии RFC и policy.

### 2.7. Внутренний evidence pack

Tenant/group-scoped research export объединяет:

- messages;
- activities;
- subject-level counts and dates;
- feedback;
- trace links/payload;
- prompt/taxonomy versions;
- human labels/notes;
- coverage.

Формат первого пилота — JSON/JSONL + Markdown summary через typed CLI. Web research panel не требуется.

Evidence pack является внутренним артефактом. Его нельзя отправить компании вместо report artifact.

### 2.8. Клиентская карта автоматизации

Каждая рекомендация содержит:

- процесс или рутину;
- функцию/отдел/должность, если это полезно;
- наблюдаемую проблему;
- системы;
- evidence summary без subject identifiers;
- confidence;
- вариант полной или частичной автоматизации;
- роль человека в цикле;
- ожидаемый эффект;
- prerequisites и риски;
- следующие шаги 30/60/90 дней.

Компания не получает:

- личные profile fields сотрудника (`typicalTasks`, `aiLevel`, `programGoal`);
- raw conversation/transcript;
- execution trace;
- `subject_key` и identity mapping;
- research notes;
- индивидуальную оценку продуктивности, лояльности или качества работы;
- прямой product access.

Методолог вручную проверяет и редактирует report artifact до передачи. На пилоте автоматической публикации нет.

### 2.9. Confidence вместо универсального правила ≥5

Порог contributors становится показателем силы evidence, а не универсальным privacy-запретом.

Стартовые уровни до калибровки первым внешним циклом:

- `hypothesis` — один subject, одна дата или слабая повторяемость; требуется интервью/проверка;
- `signal` — не менее двух subjects либо устойчивая повторяемость процесса у одного subject в несколько дат;
- `confirmed` — не менее трёх subjects, не менее пяти наблюдений и не менее трёх дат.

Report показывает confidence и ограничения. Конкретная рекомендация по редкой должности допустима как гипотеза, если она описывает процесс/автоматизацию и не превращается в оценку единственного сотрудника.

Точные пороги пересматриваются после первого цикла на основании distribution реальных данных. Число 5 не является красной линией.

### 2.10. Retention и удаление

До первого внешнего пилота автоматический TTL для corpus/traces не задаётся: неизвестно, какие данные и на каком горизонте потребуются для повторного анализа и evaluation.

Обязательная управляемость:

- purge company;
- purge group;
- purge subject;
- индексы по `subject_key`;
- versioned trace schema;
- пересчёт reports после изменения/удаления evidence.

На следующем после пилота этапе появляется trace sanitizer с `delete`, `redact`, `replace`, `snapshot`. До него ручной operator purge является допустимым уровнем продукта.

### 2.11. Consent до первого внешнего пилота

`privacy-v5` остаётся неизменяемым архивным snapshot внутренних тестов. До приглашения первого внешнего участника публикуется и включается в runtime новая версия policy, которая прямо сообщает:

- команда «Алгоритма» имеет доступ к полным разговорам, structured activities и traces;
- цели: ручной анализ, prompt/taxonomy improvement и evaluation;
- компания получает только итоговую карту автоматизации и не имеет доступа к исходному корпусу;
- данные не используются для model training/fine-tuning на текущем этапе;
- автоматический срок удаления в пилоте не установлен;
- удаление выполняется оператором по company/group/subject scope;
- текст/context передаётся LLM-провайдеру, voice — STT-провайдеру, audio приложением не сохраняется.

Policy draft не становится активным только от появления файла: runtime version/env/specs переключаются в отдельной implementation task вместе с фактическим поведением.

### Ограничения и принципы

Красные линии:

1. owner и tenant isolation;
2. company delivery boundary: наружу только report artifact;
3. запись и research reads только через typed use-cases;
4. durable conversation/activity corpus не теряется тихо;
5. secrets не попадают в corpus, traces, model context, logs и Git;
6. records остаются находимыми для purge/sanitize/recompute.

Унаследованное подтверждение внешних действий сохраняется в фундаменте, но не определяет текущий reporting design: «Минутка» не выполняет работу во внешних системах в пилоте.

## 3. Что оставляем / что удаляем

| Существующее решение | Судьба |
|---|---|
| company → group → participant → role | Оставляем |
| owner/company isolation | Оставляем и распространяем на research export |
| closed structured activity contract | Оставляем как первую таксономию, разрешаем versioned refinement |
| conversation history | Оставляем как canonical corpus |
| typed use-cases | Оставляем |
| `minutka_private.activities` | Оставляем и связываем с subject/evidence |
| `minutka_reporting.anonymized_activities` | Удаляем после переключения readers |
| atomic dual-write пары | Удаляем; одна canonical activity |
| запрет subject key | Удаляем |
| запрет cross-owner research read | Заменяем tenant-scoped typed research export |
| universal ≥5 gate | Заменяем confidence/evidence policy |
| retention «до отчёта» | Заменяем manual retention + purge в пилоте |
| запрет backfill/recompute | Удаляем; пересчёт является нормальной операцией |
| methodologist sees no content | Заменяем полным доступом доверенной research-команды |
| company no raw access | Оставляем как красную линию |

## 4. Влияние

- [Старый RFC](./rfc-minutka-tenancy-and-reporting.md) помечается `superseded`; ссылки живых документов переводятся сюда.
- [Final Description](../product/Final_Description.md) становится product baseline с исследовательским корпусом и company report boundary.
- [Product brief](../product/agent-minutka-brief.md) синхронизируется по ролям, ценности, доступу и evaluation.
- `privacy-v6.html` создаётся как draft следующей policy; активный `privacy-v5` сохраняется до реализации.
- Epic `mnt-cycle-completion-4gd` и задачи report/unique contributor пересматриваются.
- Появляются задачи subject key, full traces, evidence/evaluation export, canonical reporting, dual-write removal и post-pilot sanitizer.
- `AGENTS.md` red lines меняются с «privacy по составу anonymized row» на tenant isolation + company delivery boundary + reversible research corpus.

## 5. Trade-offs

**Получаем:**

- максимальную доказательную ценность данных;
- unique contributor counts;
- качественный debugging;
- prompt/taxonomy evaluation;
- пересчёт и исправление;
- более конкретные рекомендации для малых групп;
- меньше дублирующих таблиц и необратимых политик.

**Принимаем:**

- внутренний corpus содержит чувствительное рабочее содержание;
- доверенная research-команда имеет более широкие права;
- требуется честный consent до внешнего пилота;
- до sanitizer удаление и retention обслуживаются вручную;
- report safety частично зависит от ручной редакторской проверки методолога.

Отвергнут вариант «оставить anonymized dual-write и отдельно копировать full traces»: он сохраняет дублирование, две аналитические истины и сложный пересчёт. Отвергнут вариант «дать компании dashboard с фильтрами»: на пилоте он создаёт ненужную поверхность доступа вместо одного проверенного артефакта.

## 6. Error handling & деградация

- Trace exporter failure не отменяет ответ и conversation persistence; создаётся drop/missing signal.
- Activity persistence failure виден как неуспешный structured collection; conversation turn сохраняется и может быть размечен вручную.
- Research export требует tenant/group scope и прекращается целиком при mismatch.
- Report generation с малым coverage возвращает `hypothesis`/coverage notes, а не выдумывает подтверждённость.
- До удаления old dual-write новая и старая отчётность могут существовать параллельно только на migration stage; клиентский артефакт формируется одним выбранным implementation path.

## 7. Не-цели и когда пересмотреть

- Не web-панель исследователя — пересмотреть после первого полного цикла, если CLI/JSONL мешают работе.
- Не внешняя hosted observability как единственный store.
- Не автоматический model training/fine-tuning.
- Не сложная RBAC — пересмотреть при втором независимом исследователе или внешнем подрядчике.
- Не окончательная confidence formula — откалибровать после первого внешнего цикла.
- Не автоматический retention TTL — принять после анализа объёма и повторного использования данных.
- Не trace PII sanitizer до первого цикла; задача обязательна в post-pilot roadmap.
- Не автоматическая публикация отчёта компании.

## 8. Порядок реализации

1. Документы, roadmap и policy draft.
2. `subject_key` и research identity projection.
3. Full trace store/exporter и trace-drop monitoring.
4. Evidence/evaluation export.
5. Subject-aware canonical reporting и client DTO/template.
6. Переключение consent/runtime на новую policy до первого внешнего invite.
7. Удаление anonymized dual-write и старых retention paths.
8. Integration gate: Telegram → corpus/activity/trace → evidence pack → client report.
9. После пилота: sanitizer и calibrated retention.

## 9. Definition of Done решения

- Внешний participant получает новую policy до записи первого сообщения.
- Один ход создаёт canonical conversation, structured activity при наличии и full trace либо visible missing marker.
- Research export по group содержит subject-linked messages/activities/traces и не смешивает tenant.
- Company report DTO не содержит subject keys, raw messages, traces и identity mapping.
- Один subject с множеством сообщений не изображается как множество contributors.
- Редкая роль может дать `hypothesis`, но не персональную оценку.
- После переключения читателей `anonymized_activities` и dual-write удалены.
- `npm run verify` и persistence gate зелёные.

## 10. Открытые вопросы

1. Точные confidence thresholds после первого цикла.
2. Формат хранения report artifact и срок хранения переданных файлов.
3. Нужен ли отдельный UI для human labels или достаточно JSONL/CLI.
4. Какие поля sanitizer заменяет автоматически, а какие требуют ручной проверки.
5. Нужно ли сохранять межцикловую связь одного участника — по умолчанию нет.
