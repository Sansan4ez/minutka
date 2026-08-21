# Research corpus export и evaluation

## Назначение

Operator-команда экспортирует внутренний evidence corpus ровно одной компании и учебной группы. Результат предназначен исследователю/методологу для ручного анализа, prompt/taxonomy improvement, разметки и offline evaluation. Это не клиентский отчёт: corpus содержит псевдонимизированные разговоры, активности и полные execution traces. Model training/fine-tuning этим workflow не выполняется. Доступ и цели раскрыты участнику в активном `privacy-v6` до consent.

Перед запуском загрузите операторское PostgreSQL-окружение и примените миграции:

```bash
set -a; . ./.env; set +a
npm run db:status
```

## Экспорт группы

JSON сохраняет единый versioned документ:

```bash
npm run research:corpus -- export \
  --company company_id \
  --group group_id \
  --format json > research-corpus.json
```

JSONL удобен для построчной обработки. Первая строка — manifest со scope, versions и coverage; следующие строки имеют `recordType` (`subject`, `message`, `activity`, `trace`, `evaluation_case`):

```bash
npm run research:corpus -- export \
  --company company_id \
  --group group_id \
  --format jsonl > research-corpus.jsonl
```

Markdown выдаёт только ручную сводку coverage и versions, без corpus payload:

```bash
npm run research:corpus -- export \
  --company company_id \
  --group group_id \
  --format markdown > research-summary.md
```

Каждый запуск требует одновременно `company_id` и `group_id`. Application-use-case прекращает export, если источник возвращает запись другого scope. Выход не содержит `employee_id`, thread/Telegram identifiers, credentials или invite secrets. Для каждого canonical message поле `trace.status` равно `present` либо `missing`; отсутствие trace не скрывается.

Audit event `research_corpus_exported` содержит только scope, outcome и counts (`subjects`, `messages`, `activities`, `traces`, feedback/evaluation и trace coverage). Raw messages, subject keys, labels, notes и traces в audit metadata не копируются.

## Human evaluation case

Основной путь к уже созданным cases — scoped list, без полного export:

```bash
npm run research:corpus -- evaluation list \
  --company company_id \
  --group group_id
```

Команда возвращает `caseId`, `subjectKey`, `traceId`, human labels и `createdAt` для всех cases exact scope. Чужая company/group не подмешивается; без обоих tenant keys команда не запускается. Audit event `research_evidence_read` сохраняет только scope, операцию, outcome и count — labels, notes, subject/trace ids в audit не копируются.

Затем выберите `traceId` через `traces list`/`traces get` по процедуре [`research-traces.md`](./research-traces.md). Case создаётся только если trace существует в указанной company/group; version anchors и correlation refs копируются из trace, а не вводятся вручную:

```bash
npm run research:corpus -- evaluation create \
  --company company_id \
  --group group_id \
  --trace trace_id \
  --usefulness useful \
  --accuracy accurate \
  --clarification not_needed \
  --extraction correct \
  --notes "Краткая проверяемая заметка методолога"
```

Допустимые labels:

- usefulness: `useful`, `partly_useful`, `not_useful`, `not_applicable`;
- accuracy: `accurate`, `partly_accurate`, `inaccurate`, `not_applicable`;
- clarification: `needed`, `not_needed`, `unclear`;
- extraction correctness: `correct`, `partly_correct`, `incorrect`, `not_applicable`.

Прочитать case можно только с тем же exact scope:

```bash
npm run research:corpus -- evaluation get \
  --company company_id \
  --group group_id \
  --case case_id
```

После разметки повторите JSONL export: строки `evaluation_case` войдут в corpus рядом с referenced trace/message/subject и сохранят `promptVersion`, `processVersion`, `taxonomyVersion` и `model` для сравнения версий.

## Retention, purge и recompute

Автоматического TTL у corpus/traces в пилоте нет. Operator retention выполняется вручную и одинаково трактуется во всех контурах:

- **company purge** удаляет research scope компании: `npm run research:scope:purge -- --company <company_id>`;
- **group purge** удаляет exact company/group scope: `npm run research:scope:purge -- --company <company_id> --group <group_id>`;
- **subject purge** удаляет participant и связанные canonical messages, activities, traces, feedback/evaluation по `subject_key`: `npm run employee:data:delete -- <employee_id>`;
- после correction или purge report command перечитывает актуальный canonical corpus и пересчитывает evidence/client DTO;
- уже переданный client artifact не отзывается и не заменяется автоматически.

`subject_key` — lookup/correlation handle, а не credential. Перед irreversible purge оператор сверяет exact company/group/subject scope, фиксирует ticket без raw corpus и использует typed command; ad-hoc unscoped SQL не является штатной процедурой. Порядок исполнения: [`research-scope-purge.md`](./research-scope-purge.md) для company/group и [`employee-personal-data-deletion.md`](./employee-personal-data-deletion.md) для subject. Отдельной anonymized reporting-копии activities нет.

## Ручной analysis workflow

1. Сохраните JSONL export группы и Markdown coverage summary.
2. Проверьте `messagesMissingTrace`; сопоставьте missing rows с `trace_missing` по процедуре [`research-traces.md`](./research-traces.md).
3. Используйте `traces list` с фильтрами subject/date и `traces get` для точечной инспекции; группируйте evidence по `subjectKey`, `roleId`, message/activity/trace refs и версиям.
4. Создайте evaluation cases для полезных, ошибочных и требующих уточнения примеров, затем проверьте набор через `evaluation list`.
5. Повторите export и используйте version anchors для offline regression comparison.
6. Клиенту передавайте только отдельный report artifact; corpus, traces, subject keys и evaluation notes наружу не публикуются.
