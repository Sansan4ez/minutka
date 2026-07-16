# Импорт pilot knowledge base

Команда переносит локальный `vault/user/knowledge_base` в owner-scoped `DocumentStore` (MinIO) под `context/imported-knowledge-base/*`. Она требует явный `PILOT_USER_ID`, не угадывает владельца и пишет только через `IngestionService`.

## Подготовка

1. Сделать резервную копию локального каталога вне репозитория.
2. Поднять подготовленный MinIO bucket с включённым versioning по [runbook локального MinIO](minio-local.md).
3. Экспортировать конфигурацию; реальный owner ID не добавлять в `.env.example` или git:

```bash
set -a; . ./.env; set +a
export PILOT_USER_ID='<trusted-owner-id>'
```

Команда принимает только allow-listed дерево `vault/user/knowledge_base`: каталоги `00_inbox`, `10_user_memory`, `20_work`, `30_knowledge`, `40_projects`, `50_finance`, `60_outbox`, `90_agent_memory`, `99_system` и корневой `AGENTS.MD`. Допустимы `.md`, `.txt` и `.vtt`; symlink или неизвестный корневой entry останавливает импорт.

## Dry-run

```bash
npm run pilot:knowledge-base:import -- --dry-run
```

Вывод — JSON с destination paths, размерами, общим количеством и числом байтов. Содержимое документов и `PILOT_USER_ID` не печатаются. Dry-run не подключается к MinIO.

## Импорт

```bash
npm run pilot:knowledge-base:import
```

Результат для каждого path имеет статус:

- `imported` — объекта раньше не было;
- `updated` — существующий объект отличался и получил новую version;
- `skipped` — содержимое совпадает побайтно.

Повторный запуск с тем же owner и неизменными файлами возвращает только `skipped`. Другой `PILOT_USER_ID` создаёт отдельный owner scope; поэтому перед запуском сверить ID с доверенным источником транспорта.

## Проверка

1. Повторить команду и убедиться, что `updated=0`, `imported=0`.
2. Проверить в MinIO Console, что объекты находятся только под `<PILOT_USER_ID>/context/imported-knowledge-base/`.
3. Запустить ассистента и убедиться, что `/proc/context` текущего owner содержит ожидаемые paths, а для другого owner они отсутствуют.
4. Не удалять локальную резервную копию до завершения Telegram smoke из задачи A3.4.

## Rollback и восстановление версии

Bucket versioning обязателен. Импорт не удаляет предыдущие object versions.

1. Остановить повторные импорты.
2. В MinIO Console открыть нужный объект `<PILOT_USER_ID>/context/imported-knowledge-base/<path>` и список версий.
3. Скачать нужную предыдущую версию, проверить её локально и восстановить содержимое поддерживаемым `DocumentStore`/import путём. Не изменять raw object key и не переносить версию между owner prefixes.
4. Если импорт выполнен под ошибочным owner, сначала подтвердить правильный импорт под верным owner. Удаление ошибочного owner scope выполнять отдельно через одобренную data-deletion процедуру; не использовать массовое удаление bucket.

Локальный `vault/user/knowledge_base/` игнорируется git и сохраняется на рабочей машине. Для полной очистки git history требуется отдельная согласованная операция с ротацией репозитория; обычный импорт её не выполняет.
