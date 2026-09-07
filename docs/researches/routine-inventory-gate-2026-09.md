# Integration gate инвентаря рутин — 2026-09

**Задача:** `mnt-xa71.19`
**Spec:** `SPEC-MINUTKA-ROUTINE-INVENTORY-GATE-001`

## Результат

Сценарий на in-memory adapters и mock generator проходит без сети и проверяет сквозной путь:

1. bounded extractor получает role-scoped directory section и возвращает `routineId` для одного участника и свободный `routineLabel` для другого;
2. обе записи проходят typed `CollectActivityService`;
3. `CompanyReportingService` пересчитывает internal v2 (`timeBudget`, `routines`, `preflightFindings`) и client v2;
4. client serialization не содержит subject/employee ids, routine ids/keys/labels, variants, evidence или source refs;
5. `unnamed_routine` с severity `high` блокирует publish, после `resolvePreflightFinding` publish возвращает client artifact;
6. `CycleActivitySummaryService` показывает только routines владельца и не видит routine другого участника;
7. purge subject A удаляет shared directory entry и создаёт tombstone, canonical activity сохраняется, а повторный report показывает dangling id как свободную routine label.

## Чек-лист красных линий

| Красная линия | Результат | Проверка |
| --- | --- | --- |
| owner/company/group isolation | PASS | typed activity writes, owner cycle read, report exact-scope assertions, scoped purge plan |
| company delivery boundary | PASS | client JSON assertions in gate spec; only `client` is publish artifact |
| typed writes/reads | PASS | `CollectActivityService`, `CompanyReportingService`, `CycleActivitySummaryService` |
| report path без сети | PASS | mock extractor/generator and in-memory stores; no provider/network calls |
| purge справочника | PASS | `runRoutineDirectoryPurge`, tombstone and dangling-id recompute assertions |
| секреты вне corpus/traces/model/logs | PASS | gate fixture has no secret material; client/audit assertions contain no payload |

## Verification

- `npx vitest run specs/executable/minutka/SPEC-MINUTKA-ROUTINE-INVENTORY-GATE-001.spec.ts` — focused gate: PASS.
- `npm run verify` — PASS.
- `npm run specs:persistence` — PASS, 56/56 тестов (2026-09-07; настроенная PostgreSQL test database, миграции 0001–0079).
- `git diff --check` — PASS.

Persistence gate выполнен на локальной тестовой PostgreSQL; credentials и database payload в репозиторий не добавлялись.
