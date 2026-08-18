# Справочники компании, учебной группы и должностей

Справочники тенантности заводятся оператором или методологом по [RFC мультитенантного контура](../architecture/rfc-minutka-tenancy-and-reporting.md#21-модель-тенантности). В первом пилоте отдельной админки нет: операторский скрипт подключается миграторными учётными данными, а runtime получает только чтение справочников.

## Предусловия

Примените миграции и загрузите окружение с `MIGRATION_DATABASE_URL` роли `minutka_migrator`, а не runtime-роли:

```bash
set -a; . ./.env; set +a
npm run db:migrate
```

Не передавайте пароль в аргументах процесса и не сохраняйте реальные данные пилота в репозитории.

## Заведение компании, группы и должностей

Подготовьте JSON-файл вне репозитория. Период задаётся датами: `periodFrom` включена, `periodToExclusive` не включена. Идентификаторы должны быть непустыми и стабильными.

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
    "periodToExclusive": "2026-10-01"
  },
  "roles": [
    { "id": "role_acme_sales", "name": "Менеджер по продажам" },
    { "id": "role_acme_logistics", "name": "Логист" },
    { "id": "role_acme_accounting", "name": "Бухгалтер" }
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
  --employee employee_acme_001 \
  --company company_acme \
  --group group_acme_2026_09 \
  --bot minutka_example_bot
```

При первом создании participant runtime генерирует случайный `subject_key`. Оператор не задаёт ключ и не передаёт его сотруднику или модели. Повторный вызов для существующего `employeeId` не меняет ключ; участие в новой группе оформляется новым participant/employee identifier и получает новый ключ. В test/dev после миграции `0056_add_research_subject_keys.sql` существующие записи получают случайные ключи автоматически.

Research readers всегда задают одновременно `company_id` и `group_id`. Их DTO содержит только `subjectKey`, `roleId` и evidence refs; ФИО, `employeeId`, invite code и Telegram identifiers в эту проекцию не входят. `subjectKey` служит корреляцией и однозначным lookup для purge/sanitize, но не credential: employee API и agent tools его не принимают.

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
  daterange(DATE '2026-09-01', DATE '2026-10-01', '[)')
);

INSERT INTO minutka_reference.roles (id, company_id, name)
VALUES
  ('role_acme_sales', 'company_acme', 'Менеджер по продажам'),
  ('role_acme_logistics', 'company_acme', 'Логист'),
  ('role_acme_accounting', 'company_acme', 'Бухгалтер');

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
