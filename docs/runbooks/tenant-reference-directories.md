# Справочники компании, учебной группы и должностей

Справочники тенантности заводятся оператором или методологом по [RFC мультитенантного контура](../architecture/rfc-minutka-tenancy-and-reporting.md#21-модель-тенантности). В первом пилоте отдельной админки нет: операторский скрипт подключается миграторными учётными данными, а runtime получает только чтение справочников.

## Предусловия

Примените миграции и загрузите окружение с `MIGRATION_DATABASE_URL` роли `minutka_migrator`, а не runtime-роли:

```bash
set -a; . ./.env; set +a
npm run db:migrate
```

Не передавайте пароль в аргументах процесса и не сохраняйте реальные данные пилота в репозитории.

## Правила справочника должностей

Должность — **точный справочник фактических функций**, а не инструмент приватности. Порог достаточности свидетельств задаётся отдельной политикой отчётности ([RFC §2.9](../architecture/rfc-minutka-research-corpus-and-reporting.md#29-confidence-вместо-универсального-правила-5)) и не влияет на состав справочника.

- **Узкий role id по фактической должности.** Один id на одну должность: `role_<company>_<narrow_title>`. Одинаковые должности выбирают **общий** id: два логиста — один `role_..._logistician`, два менеджера отдела продаж — один `role_..._sales_manager`.
- **Персональные роли запрещены.** Роль не именуется по человеку и не получает порядковый суффикс на участника. Идентичность живёт в `employeeId` и приватном контуре, а не в справочнике.
- **Широкие роли запрещены.** Никакого общего «Менеджера», «Специалиста» или искусственного «коммерческого блока»: укрупнение смешивает разные процессы и обесценивает карту автоматизации.
- **Пробелы, регистр и варианты обращения не создают новых записей.** Перед seed привести названия к одному написанию.
- **Отдельной оси `department` в первой когорте нет.** Логистика (2), продажи (2), телемаркетинг (1), тендеры (1), бухгалтерия (1) и руководство (2) не образуют privacy-safe подразделения ≥5, а искусственное объединение смешало бы разные процессы. Пересмотреть только для следующей когорты со стабильным оргсправочником и минимум пятью участниками в подразделении.
- В отчёте роль остаётся metadata для coverage и `insufficient_data`. Рекомендации строятся по process/system-паттернам всей группы, а не по редким срезам одной роли.

## Заведение компании, группы и должностей

Подготовьте JSON-файл вне репозитория. Период задаётся датами: `periodFrom` включена, `periodToExclusive` не включена. Идентификаторы должны быть непустыми и стабильными.

Безопасные шаблоны без ФИО лежат в репозитории и проверяются спекой `SPEC-MINUTKA-PILOT-COHORT-DIRECTORY-001`:

- [`examples/tenant-seed-green-line.template.json`](./examples/tenant-seed-green-line.template.json) — первая когорта компании: семь точных должностей;
- [`examples/tenant-seed-algoritm-institute.template.json`](./examples/tenant-seed-algoritm-institute.template.json) — тестовая группа организаторов: методист и преподаватель;
- [`examples/pilot-participant-bindings.template.json`](./examples/pilot-participant-bindings.template.json) — плановая привязка участников к должностям.

Шаблон копируется в защищённый каталог вне репозитория; даты периода и идентификаторы правятся под конкретный запуск. ФИО в файлы не попадают: `employeeId` — порядковый непрозрачный идентификатор, а сопоставление «порядок ↔ человек» ведёт оператор в своём приватном списке.

```json
{
  "company": {
    "id": "company_acme",
    "name": "ООО «Пример»"
  },
  "group": {
    "id": "group_acme_2026_09",
    "name": "Пилот — сентябрь 2026",
    "periodFrom": "2026-09-01",
    "periodToExclusive": "2026-09-15"
  },
  "roles": [
    { "id": "role_acme_sales_manager", "name": "Менеджер отдела продаж" },
    { "id": "role_acme_logistician", "name": "Логист" },
    { "id": "role_acme_accountant", "name": "Бухгалтер" }
  ]
}
```

Запустите создание комплекта:

```bash
npm run tenant:seed -- seed --file /secure/path/company-acme.json
```

Скрипт собирает PostgreSQL `daterange` и создаёт компанию, группу и все должности одной транзакцией. Результат со `status: "created"` печатает созданный комплект. Повторный запуск того же файла не создаёт дублей и печатает `status: "already_exists"`. Если существующая или частично созданная запись отличается от файла, скрипт останавливается и ничего не перезаписывает.

Ошибка FK, уникальности, пустого значения или даты откатывает весь комплект. Скрипт требует `MIGRATION_DATABASE_URL`; `DATABASE_URL` runtime-роли для этой операции не используется.

## Приглашение участников и research identity

После создания справочников выдавайте каждый invite в конкретную группу:

```bash
npm run cli -- admin invite \
  --employee emp_acme_01 \
  --company company_acme \
  --group group_acme_2026_09 \
  --bot minutka_example_bot
```

`admin invite` не задаёт должность: `roleId` выбирает сам сотрудник на онбординге из справочника своей компании. Поэтому плановая привязка из `pilot-participant-bindings.template.json` — это то, что оператор **сверяет** после онбординга, а не то, что он записывает. `admin list-participants` показывает статус и вовлечённость, но не должность, поэтому сверка идёт диагностическим SQL:

```bash
psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v company_id=company_acme -v group_id=group_acme_2026_09 <<'SQL'
SELECT employee_id, role_id, status
FROM minutka_private.participants
WHERE company_id = :'company_id' AND group_id = :'group_id'
ORDER BY employee_id;
SQL
```

Расхождение с плановой должностью исправляется вместе с сотрудником, а не правкой строки в БД.

При первом создании participant runtime генерирует случайный `subject_key`. Оператор не задаёт ключ и не передаёт его сотруднику или модели. Повторный вызов для существующего `employeeId` не меняет ключ; участие в новой группе оформляется новым participant/employee identifier и получает новый ключ. В test/dev после миграции `0056_add_research_subject_keys.sql` существующие записи получают случайные ключи автоматически.

Research readers всегда задают одновременно `company_id` и `group_id`. Их DTO содержит только `subjectKey`, `roleId` и evidence refs; ФИО, `employeeId`, invite code и Telegram identifiers в эту проекцию не входят. `subjectKey` служит корреляцией и однозначным lookup для purge/sanitize, но не credential: employee API и agent tools его не принимают.

## Generic mapping типов систем

Словарь систем (`activitySystems` в `src/domain/insights.ts`) — **глобальный и закрытый**: он описывает *типы* систем, а не продукты компании. До первого сбора оператор берёт у компании короткий inventory типов систем — без секретов, доступов и внутренних названий — и фиксирует mapping в этой таблице. Точные бренды и внутренние названия остаются в переписке оператора и в строку активности не попадают.

| Тип системы в inventory | Значение словаря | Примеры, которые оператор маппит на него |
|---|---|---|
| CRM на Bitrix24 | `bitrix24` | Bitrix24 |
| Другая CRM | `crm` | amoCRM, отраслевая или самописная CRM |
| Учётная система, ERP | `one_c` | 1С:УТ, 1С:Бухгалтерия, 1С:УНФ |
| Таблицы | `spreadsheets` | Excel, Google Sheets |
| Почта | `email` | корпоративная и внешняя почта |
| Мессенджеры и видеозвонки | `messengers` | Telegram, WhatsApp, звонки и встречи в мессенджере или видеосервисе |
| Таск-трекер | `task_tracker` | задачи Bitrix24, Trello, Jira, Планфикс |
| Телефония, call-center | `telephony` | облачная АТС, панель оператора, обзвон |
| Тендерная площадка | `tender_platform` | ЕИС/zakupki, B2B-Center, Росэлторг |
| Логистическая система, TMS/WMS | `logistics_system` | TMS/WMS, кабинеты перевозчиков, логистические порталы |
| Платформа обучения, СДО | `learning_platform` | LMS/СДО, кабинет курса |
| Бумага или устно | `paper_or_verbal` | бумажный документ, устная договорённость |
| Не покрыто mapping'ом | `other` | фиксируется как misfit, а не как норма |

**Правила расширения.** Per-company словарь отклонён ([RFC §5](../architecture/rfc-minutka-tenancy-and-reporting.md#5-trade-offs)): свободное пополнение компанией — это возврат свободного текста через боковую дверь. Новое значение добавляется только правкой кода и только когда фактический inventory не покрыт, одной поставкой: `src/domain/insights.ts`, миграция с `activities_system_check`, метка в `src/application/company-reporting.ts` и спеки. Парность словаря и CHECK держит `ACTIVITY-SYSTEM-DICTIONARY-PARITY`; contract- и tool-схемы выводятся из словаря автоматически. Consent-тексты словарь систем не перечисляют и правки не требуют.

**Заранее не расширять `task_category`.** Первая когорта работает на существующих cross-functional категориях и словарях помех. Расширение допустимо только по документированному misfit из первой недели сбора.

## Проверка скоупа компании

Каждая выборка групп и должностей принимает `company_id` явно:

```bash
npm run tenant:seed -- inspect --company-id company_acme
```

Результат содержит одну компанию и только её группы и должности. Для проверки изоляции повторите команду с идентификатором другой компании: в результате не должно быть записей первой компании. Уникальность названия должности действует только внутри компании: одинаковое название допустимо у разных компаний, повтор внутри одной компании отклоняется.

## Справочный SQL

SQL остаётся аварийным и диагностическим путём. Для него нужен PostgreSQL-клиент `psql` и `MIGRATION_DATABASE_URL`.

Одна транзакция создаёт весь комплект:

```bash
psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;

INSERT INTO minutka_reference.companies (id, name)
VALUES ('company_acme', 'ООО «Пример»');

INSERT INTO minutka_reference.training_groups (id, company_id, name, period)
VALUES (
  'group_acme_2026_09',
  'company_acme',
  'Пилот — сентябрь 2026',
  daterange(DATE '2026-09-01', DATE '2026-09-15', '[)')
);

INSERT INTO minutka_reference.roles (id, company_id, name)
VALUES
  ('role_acme_sales_manager', 'company_acme', 'Менеджер отдела продаж'),
  ('role_acme_logistician', 'company_acme', 'Логист'),
  ('role_acme_accountant', 'company_acme', 'Бухгалтер');

COMMIT;
SQL
```

Справочная проверка скоупа:

```bash
export COMPANY_ID=company_acme

psql "$MIGRATION_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -v company_id="$COMPANY_ID" <<'SQL'
SELECT id, name
FROM minutka_reference.companies
WHERE id = :'company_id';

SELECT id, name, lower(period) AS period_from, upper(period) AS period_to_exclusive
FROM minutka_reference.training_groups
WHERE company_id = :'company_id'
ORDER BY name, id;

SELECT id, name
FROM minutka_reference.roles
WHERE company_id = :'company_id'
ORDER BY name, id;
SQL
```
