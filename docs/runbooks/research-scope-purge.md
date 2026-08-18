# Purge исследовательского scope компании и группы

Оператор удаляет исследовательский scope выбранной компании или одной её учебной группы одной irreversible-командой через typed use-case. Агент не получает purge-инструмента и только объясняет процедуру. Клиентская компания в исполнении не участвует: запрос принимает и выполняет доверенный оператор.

Основание: [RFC исследовательского корпуса §2.10](../architecture/rfc-minutka-research-corpus-and-reporting.md#210-retention-и-удаление) и активный процесс [`consent_and_privacy`](../../vault/assistant/processes/consent_and_privacy.md). Удаление по запросу одного сотрудника выполняется отдельной процедурой [`employee-personal-data-deletion.md`](./employee-personal-data-deletion.md).

## Что удаляется

Scope задаётся точно: либо `--company <company_id>`, либо `--company <company_id> --group <group_id>`. Всё остальное не является typed-операцией. Внутри выбранного scope удаляются:

- participants, профили и consent snapshots;
- canonical messages, threads, summaries, активности, feedback и персональные insights;
- research execution traces и evaluation cases (каскадно по composite tenant/subject keys миграции `0062`);
- расписания и журнал срабатываний, Telegram-session, action messages и pending-action groups, черновики онбординга;
- личные идеи, задачи, confirmation records, артефакты и owner-scoped usage records унаследованного runtime;
- личные audit events;
- все версии объектов MinIO под префиксом каждого сотрудника scope.

Что **не** удаляется:

- reference-справочники `minutka_reference` (компания, группы, должности): исследовательских данных они не содержат, и та же группа может быть приглашена заново;
- одна audit-запись `research_scope_purged` без employee id и subject keys: в ней остаются только scope, счётчики и outcome;
- другая компания и другая группа той же компании: purge `company_a` не меняет `company_b`, purge `group_a1` не меняет `group_a2`;
- уже переданный компании client artifact не отзывается автоматически. Если отчёт ещё не передан, оператор пересчитывает его из оставшегося canonical evidence.

Удаление participants отзывает digest их старых инвайтов: подключиться можно только по новому инвайту оператора.

## Подготовка

1. Зафиксируйте операторский тикет с точным scope и основанием, без raw corpus и без списка subject keys.
2. Загрузите production-переменные PostgreSQL и MinIO.
3. Не запускайте команду параллельно с обработкой сообщений сотрудников этого scope.

## Выполнение

Сначала dry run — команда печатает scope, счётчики и строку подтверждения и ничего не удаляет:

```bash
npm run research:scope:purge -- --company <company_id> --preview
npm run research:scope:purge -- --company <company_id> --group <group_id> --preview
```

Затем сам purge:

```bash
npm run research:scope:purge -- --company <company_id>
npm run research:scope:purge -- --company <company_id> --group <group_id>
```

Команда снова печатает scope и счётчики, затем требует level-2 подтверждение. Введите строку из prompt ровно в форме:

```text
PURGE COMPANY <company_id>
PURGE GROUP <company_id>/<group_id>
```

Любой другой ввод завершает команду с `confirmation did not match; nothing was purged` и ничего не удаляет. Пустой scope (нет ни одного participant) завершается с `research_scope_not_found`.

После успеха команда печатает JSON: `scope`, счётчики удалённых записей, `minioObjectVersions` и явный перечень сохранённого.

## Проверка

1. Сверьте `deleted.participants` с preview и убедитесь, что `oldInvitesRevoked` равен `true`.
2. Проверьте, что в выбранном scope не осталось participants, canonical messages и activities, `minutka_research.traces` и `minutka_research.evaluation_cases`.
3. Проверьте, что соседний scope не тронут: другая компания и другая группа той же компании сохраняют свои записи.
4. Попытка открыть старый invite сотрудника scope должна вернуть `invite_not_found`.
5. Убедитесь, что в `minutka_audit.events` появилась ровно одна запись `research_scope_purged` с `employee_id IS NULL`, scope, счётчиками и `outcome`.
6. Если client report ещё не передан, запустите [`company-report-export`](./company-report-export.md) повторно: report path перечитывает актуальный canonical corpus. Если отчёт передан — не обещайте автоматический отзыв или замену.

Если удаление объектов MinIO завершилось, а транзакция PostgreSQL упала, устраните причину и повторите ту же команду: participants ещё существуют, а повторное удаление отсутствующих объектов безопасно. После успешной транзакции результат необратим; новый доступ создаётся только новыми инвайтами.
