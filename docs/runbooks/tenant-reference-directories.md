# Справочники компании, учебной группы и должностей

Справочники тенантности заводятся оператором или методологом вручную по [RFC мультитенантного контура](../architecture/rfc-minutka-tenancy-and-reporting.md#21-модель-тенантности). В первом пилоте отдельной админки нет: мигратор выполняет DML через SQL, а runtime получает только чтение справочников.

## Предусловия

Примените миграции и подключайтесь учётными данными `minutka_migrator`, а не runtime-роли:

```bash
set -a; . ./.env; set +a
npm run db:migrate
```

Для следующих команд нужен PostgreSQL-клиент `psql`. Не передавайте пароль в аргументах процесса и не сохраняйте реальные данные пилота в репозитории.

## Заведение компании, группы и должностей

Одна транзакция создаёт весь комплект. `period` — PostgreSQL `daterange`: нижняя граница включена, верхняя не включена. Идентификаторы назначает оператор; они должны быть непустыми и стабильными.

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

Если любая строка не проходит FK, уникальность или проверку непустого значения, `ON_ERROR_STOP` и транзакция не оставляют частично созданный комплект.

## Проверка скоупа компании

Каждая выборка групп и должностей принимает `company_id` явно. Не используйте неспецифицированные выборки всех компаний в операторских выгрузках.

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

Для проверки изоляции повторите блок с идентификатором другой компании. В результате не должно быть групп или должностей первой компании. Уникальность названия должности действует только внутри компании: одинаковое название допустимо у разных компаний, повтор внутри одной компании отклоняется.
