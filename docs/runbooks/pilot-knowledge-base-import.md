# Импорт pilot knowledge base

Команда переносит локальный `vault/user/knowledge_base` в owner-scoped `DocumentStore` (MinIO) под канонические storage keys `context/*`. В runtime они отображаются как короткие `/proc/context/*`: технический prefix `imported-knowledge-base` агенту не виден. Команда требует явный `PILOT_USER_ID`, не угадывает владельца и пишет только через `IngestionService`.

## Подготовка

1. Сделать резервную копию локального каталога вне репозитория.
2. Поднять подготовленный MinIO bucket с включённым versioning по [runbook локального MinIO](minio-local.md).
3. Экспортировать конфигурацию; реальный owner ID не добавлять в `.env.example` или git:

```bash
set -a; . ./.env; set +a
export PILOT_USER_ID='<trusted-owner-id>'
```

Команда принимает только allow-listed дерево `vault/user/knowledge_base`: каталоги `00_inbox`, `10_user_memory`, `20_work`, `30_knowledge`, `40_projects`, `50_finance`, `60_outbox`, `90_agent_memory`, `99_system` и корневой `AGENTS.MD`. Допустимы `.md`, `.txt` и `.vtt`; symlink, неизвестный корневой entry, traversal или collision после Unicode/case normalization останавливает импорт.

`AGENTS.MD`, вложенные `README.MD` и `99_system/*` импортируются как обычные untrusted owner documents. Они не подменяют trusted `/AGENTS.md` и `/docs/*`.

## Dry-run

```bash
npm run pilot:knowledge-base:import -- --dry-run
```

Вывод — JSON с каноническими destination paths, размерами, общим количеством и числом байтов. Содержимое документов и `PILOT_USER_ID` не печатаются. Dry-run не подключается к MinIO.

## Импорт

```bash
npm run pilot:knowledge-base:import
```

Результат для каждого path имеет статус:

- `imported` — канонического объекта раньше не было;
- `updated` — существующий канонический объект отличался и получил новую version;
- `skipped` — содержимое совпадает побайтно.

Повторный запуск с тем же owner и неизменными файлами возвращает только `skipped`. Другой `PILOT_USER_ID` создаёт отдельный owner scope; поэтому перед запуском сверить ID с доверенным источником транспорта.

## Миграция legacy prefix

Для объектов, ранее импортированных под `context/imported-knowledge-base/*`, выполнить:

```bash
npm run pilot:knowledge-base:import -- --migrate-legacy
```

Миграция:

- копирует найденные legacy objects в соответствующие `context/*` keys через `IngestionService`;
- не удаляет legacy object и его versions, поэтому rollback остаётся доступен;
- повторный запуск возвращает `skipped`;
- fail closed останавливается, если канонический key уже содержит отличающееся содержимое.

До миграции compatibility lookup и list projection читают legacy object через канонический логический path. Если существуют оба варианта, канонический object имеет приоритет.

## Проверка

1. Повторить import или migration и убедиться, что новых `imported`/`migrated` и `updated` нет.
2. Проверить в MinIO Console, что новые объекты находятся только под `<PILOT_USER_ID>/context/`, без `imported-knowledge-base`.
3. Запустить ассистента и убедиться, что `/proc/context` текущего owner содержит `/proc/context/10_user_memory/*`, а physical storage paths и данные другого owner отсутствуют.
4. Убедиться, что owner `AGENTS.MD`, `README.MD` и `99_system/*` отображаются только внутри fenced `user-context` и не меняют trusted runtime manual.
5. Не удалять локальную резервную копию до завершения Telegram smoke из задачи A3.4.

## Rollback и восстановление версии

Bucket versioning обязателен. Импорт и migration не удаляют предыдущие object versions.

1. Остановить повторные импорты.
2. В MinIO Console открыть нужный объект `<PILOT_USER_ID>/context/<path>` и список версий. Для legacy rollback исходный объект остаётся под `<PILOT_USER_ID>/context/imported-knowledge-base/<path>`.
3. Скачать нужную предыдущую версию, проверить её локально и восстановить содержимое поддерживаемым `DocumentStore`/import путём. Не изменять raw object key и не переносить версию между owner prefixes.
4. Если импорт выполнен под ошибочным owner, сначала подтвердить правильный импорт под верным owner. Удаление ошибочного owner scope выполнять отдельно через одобренную data-deletion процедуру; не использовать массовое удаление bucket.

Локальный `vault/user/knowledge_base/` игнорируется git и сохраняется на рабочей машине. Для полной очистки git history требуется отдельная согласованная операция с ротацией репозитория; обычный импорт её не выполняет.
