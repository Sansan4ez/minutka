# Внешний owner vault и импорт pilot knowledge base

> **Унаследовано от персонального ассистента.** Команды и стек служат операционным фундаментом клона; хосты, unit names и пути должны быть перенастроены под «Минутку». Живые продуктовые и privacy-решения: [RFC «Минутки»](../architecture/rfc-minutka-tenancy-and-reporting.md).


Канонический owner workspace живёт вне application repository: `/home/admin/user_knowledge_base`. Это отдельный локальный приватный Git repository без шифрования и без автоматического remote push. Игнорируемый `vault/user/knowledge_base` — только локальный symlink для ergonomics; target, сам symlink и любые `INDEX.md` под ним не являются application source и не отслеживаются Git приложения.

Команда импорта однократно bootstrap-ит этот workspace в owner-scoped `DocumentStore` (MinIO) под канонические storage keys `context/*`. После первого успешного импорта **MinIO — единственный source of truth базы знаний**. В runtime документы отображаются как короткие `/proc/context/*`: технический prefix `imported-knowledge-base` агенту не виден. Команда требует явный `PILOT_USER_ID`, не угадывает владельца и пишет только через `IngestionService`.

Git workspace и локальный symlink остаются только bootstrap source и операторской резервной копией. Runtime и агент не читают его для синхронизации и никогда не записывают изменения обратно. Bidirectional sync, background watcher и автоматический Git↔MinIO reconcile не реализуются.

## Однократная безопасная миграция workspace

Не заменять старую внешнюю копию через `rsync --delete`: backup-only файлы требуют ручной классификации. Выполнять миграцию с `umask 077` и уникальным UTC timestamp:

```bash
umask 077
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
canonical=/home/admin/user_knowledge_base
current="$PWD/vault/user/knowledge_base"
old_backup="/home/admin/user_knowledge_base.before-$stamp"
current_snapshot="/home/admin/user_knowledge_base.repo-snapshot-$stamp"
candidate="/home/admin/user_knowledge_base.candidate-$stamp"

# Read-only snapshots обеих исходных копий. Не менять их до ручной проверки.
cp -a -- "$canonical" "$old_backup"
cp -a -- "$current" "$current_snapshot"
chmod -R a-w -- "$old_backup" "$current_snapshot"

# Candidate строится только из более свежего repo-local workspace.
cp -a -- "$current" "$candidate"
find "$candidate" -type d -exec chmod 0700 {} +
find "$candidate" -type f -exec chmod 0600 {} +
```

До rename сохранить и просмотреть три manifest. `comm -13` показывает backup-only paths: переносить их в candidate можно только после явной классификации владельцем. Retired `AGENTS.MD`, старые templates и README не сливать автоматически.

```bash
manifest() { (cd "$1" && find . -type f -print0 | sort -z | xargs -0 sha256sum); }
manifest "$old_backup" > "/home/admin/user_knowledge_base.old-$stamp.sha256"
manifest "$current_snapshot" > "/home/admin/user_knowledge_base.current-$stamp.sha256"
manifest "$candidate" > "/home/admin/user_knowledge_base.candidate-$stamp.sha256"

comm -13 \
  <(cd "$current_snapshot" && find . -type f -printf '%P\n' | sort) \
  <(cd "$old_backup" && find . -type f -printf '%P\n' | sort)
find "$candidate" -type f | wc -l
npm run pilot:knowledge-base:import -- --dry-run --source "$candidate"
```

Dry-run выполняет allow-list, `INDEX.md` drift-check и content constraints. После классификации backup-only paths повторить manifests и dry-run, затем атомарно переключить sibling directories. Если первоначальный backup был создан через `cp`, canonical сначала переименовывается ещё раз; не удалять ни одну dated backup до ручной проверки:

```bash
mv -- "$canonical" "/home/admin/user_knowledge_base.replaced-$stamp"
mv -- "$candidate" "$canonical"
git -C "$canonical" init --initial-branch=main
find "$canonical" -type d -exec chmod 0700 {} +
find "$canonical" -type f -exec chmod 0600 {} +
git -C "$canonical" add --all
git -C "$canonical" commit -m "Initialize private owner vault"

rm -rf -- "$current"                 # только после успешной проверки canonical
ln -s -- /home/admin/user_knowledge_base "$current"
test -L "$current"
test -z "$(git ls-files -- vault/user/knowledge_base)"
```

Remote необязателен. Если он добавляется, сначала независимо подтвердить, что repository приватный; runbook не выполняет push. Абсолютный symlink локален и не коммитится.

### Rollback workspace

Остановить импорт и редакторы, удалить только symlink bridge, переименовать текущий canonical в новый dated failed-candidate и вернуть `user_knowledge_base.replaced-<stamp>` в canonical path. Затем восстановить owner-only permissions, пересоздать symlink и повторить dry-run. Read-only snapshots и hash manifests сохранять до ручной сверки.

### Nvim / Snacks

Поскольку bridge находится под ignored path, стандартный Git-aware picker Snacks может его скрывать. Открывать canonical path напрямую (`nvim /home/admin/user_knowledge_base`) либо для локального поиска явно включать ignored files (`ignored = true` / toggle ignored в picker). Не менять `.gitignore` и не force-add bridge ради навигации.

## Подготовка импорта

1. Убедиться, что `git -C /home/admin/user_knowledge_base status --short` чист и `git ls-files -- vault/user/knowledge_base` не выводит файлов.
2. Поднять подготовленный MinIO bucket с включённым versioning по [runbook локального MinIO](minio-local.md).
3. Экспортировать конфигурацию; реальные owner ID и host path не добавлять в `.env.example` или git:

```bash
set -a; . ./.env; set +a
export PILOT_USER_ID='<trusted-owner-id>'
export PILOT_KNOWLEDGE_BASE_ROOT=/home/admin/user_knowledge_base  # optional local override
# Optional aggregate preflight limits; defaults: 1000 Markdown documents / 16 MiB UTF-8.
# export PILOT_KNOWLEDGE_BASE_MAX_DOCUMENTS=1000
# export PILOT_KNOWLEDGE_BASE_MAX_TOTAL_BYTES=16777216
```

Приоритет source: explicit `--source` → `PILOT_KNOWLEDGE_BASE_ROOT` → compatibility path `vault/user/knowledge_base`. Root symlink разрешён и разрешается через `realpath`, если target — каталог. Любой nested, broken или file-target symlink отклоняется.

Команда принимает только allow-listed дерево: каталоги `00_inbox`, `07_rfcs`, `08_entities`, `10_user_memory`, `20_work`, `30_knowledge`, `40_projects`, `50_finance`, `60_outbox`, `90_agent_memory`, `99_system`, корневой `INDEX.md` и служебный реальный каталог `.git`, который пропускается и никогда не импортируется. Допустимы только Markdown-файлы `.md` (регистр расширения не важен). `.txt`, `.vtt`, PDF, изображения, audio/video и неизвестные расширения останавливают preflight с относительным path; содержимое и owner ID в ошибку не входят. Файлы из KB tree не превращаются в артефакты: будущий bulk artifact import требует отдельной команды/use-case. Неизвестный корневой entry, traversal или collision после Unicode/case normalization также останавливает импорт.

До подключения к MinIO проверяется полный план: единый с document tools per-document maximum, максимальное количество документов и общий объём UTF-8 bytes. Aggregate limits конфигурируются через `PILOT_KNOWLEDGE_BASE_MAX_DOCUMENTS` и `PILOT_KNOWLEDGE_BASE_MAX_TOTAL_BYTES`; превышение любого лимита не оставляет частичного импорта.

`INDEX.md`, legacy-вложенные `AGENTS.MD`/`README.MD` и `99_system/*` импортируются как обычные untrusted owner documents. Они не подменяют trusted `/AGENTS.md` и `/docs/*`. Каноническое навигационное имя — только точное `INDEX.md`; варианты регистра считаются collision. Markdown-ссылки из `INDEX.md` валидируются перед импортом: цель должна существовать и быть прямым ребёнком той же папки.

## Dry-run

```bash
npm run pilot:knowledge-base:import -- --dry-run --source /home/admin/user_knowledge_base
PILOT_KNOWLEDGE_BASE_ROOT=/home/admin/user_knowledge_base npm run pilot:knowledge-base:import -- --dry-run
npm run pilot:knowledge-base:import -- --dry-run  # compatibility symlink
```

Вывод — JSON с каноническими destination paths, размерами, общим количеством и числом байтов. Содержимое документов и `PILOT_USER_ID` не печатаются. Dry-run не подключается к MinIO.

## Импорт

```bash
npm run pilot:knowledge-base:import
```

Результат для каждого path имеет статус:

- `imported` — канонического объекта или legacy alias раньше не было;
- `skipped` — canonical MinIO content совпадает побайтно.

Если canonical document или его legacy alias уже существует и отличается от workspace, обычный import завершается `knowledge-base import conflict: context/<relative-path>` **до первой записи**. Это ожидаемая защита cutover: правка в MinIO не перезаписывается старой Git-копией. Повторный запуск с тем же owner и неизменными файлами возвращает только `skipped`. Другой `PILOT_USER_ID` создаёт отдельный owner scope; поэтому перед запуском сверить ID с доверенным источником транспорта.

### Conflict и явный overwrite

Текущая команда намеренно не имеет overwrite-флага. При conflict оператор сначала выполняет dry-run, сверяет MinIO version history и решает, какое состояние канонично. Если нужен принудительный overwrite, он выполняется только отдельной явно одобренной операторской операцией через поддерживаемый `DocumentStore`/typed mutation path при включённом bucket versioning; обычный bootstrap import для этого не переиспользуется. Перед overwrite сохранить идентификатор текущей версии, чтобы её можно было восстановить.

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

1. Повторить import или migration и убедиться, что import возвращает только `skipped`, а migration — только `skipped`.
2. Проверить в MinIO Console, что новые объекты находятся только под `<PILOT_USER_ID>/context/`, без `imported-knowledge-base`.
3. Запустить ассистента и убедиться, что `/proc/context` текущего owner содержит `/proc/context/10_user_memory/*`, а physical storage paths и данные другого owner отсутствуют.
4. Убедиться, что owner `INDEX.md`, legacy `AGENTS.MD`/`README.MD` и `99_system/*` отображаются только внутри fenced `user-context` и не меняют trusted runtime manual.
5. Не удалять локальную резервную копию до завершения Telegram smoke из задачи A3.4.

## Rollback и восстановление версии

Bucket versioning обязателен. Импорт и migration не удаляют предыдущие object versions.

1. Остановить повторные импорты.
2. В MinIO Console открыть нужный объект `<PILOT_USER_ID>/context/<path>` и список версий. Для legacy rollback исходный объект остаётся под `<PILOT_USER_ID>/context/imported-knowledge-base/<path>`.
3. Скачать нужную предыдущую версию, проверить её локально и восстановить содержимое поддерживаемым `DocumentStore`/typed mutation путём. Обычный bootstrap import не использовать для обхода conflict. Не изменять raw object key и не переносить версию между owner prefixes.
4. Если импорт выполнен под ошибочным owner, сначала подтвердить правильный импорт под верным owner. Удаление ошибочного owner scope выполнять отдельно через одобренную data-deletion процедуру; не использовать массовое удаление bucket.

Локальный `vault/user/knowledge_base/` целиком игнорируется application Git. Канонический `/home/admin/user_knowledge_base` versioned отдельно; ни его target, ни symlink, ни `INDEX.md`/другие navigation files не отслеживаются application repository. Обычный `npm run specs` содержит repository-boundary guard и падает, если любой path под bridge был добавлен в индекс, включая `git add -f`. Для полной очистки уже опубликованной Git history требуется отдельная согласованная операция с ротацией application repository; обычный импорт её не выполняет.
