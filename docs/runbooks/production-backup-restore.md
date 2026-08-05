# Production backup and restore

## Назначение

Production-host ежедневно сохраняет в
`/var/backups/personal-assistant/<UTC timestamp>/` два production-источника
durable-данных:

- `minutka.dump` — custom-format `pg_dump -Fc` PostgreSQL со всеми
  owner-scoped прикладными записями;
- `minio/personal-assistant/` — полный object-level mirror versioned bucket
  MinIO. Он содержит БЗ и artifacts всех owner-account'ов под prefix'ами
  `{owner}/context/*` и `{owner}/cas/sha256/**`.

После bootstrap import MinIO является единственным source of truth owner БЗ.
Внешние Git-репозитории — одноразовые источники импорта отдельных owner'ов, а
не production durable storage. Поэтому backup не требует локального
`/home/admin/user_knowledge_base`, не создаёт Git bundle и не блокируется его
отсутствием.

Локальный retention — 14 дней. Успешный запуск записывает Unix timestamp в
`/var/lib/personal-assistant-observability/backup.last_success`; незавершённый
каталог имеет suffix `.incomplete` и не считается backup.

## Что не входит в backup

Data backup намеренно не содержит:

- Git-репозиторий конфигурации personal-assistant;
- зашифрованный `nixos/phase3-assistant-stack/secrets/assistant.yaml` как
  отдельную копию вне config repository;
- private owner age key;
- `/etc/ssh/ssh_host_ed25519_key`, который является server age identity;
- внешние Git workspaces, использованные для импорта БЗ конкретных owner'ов;
- полный disk/VPS snapshot.

Для disaster recovery config repository, encrypted secrets bundle и owner age
private key хранятся отдельно от production VPS. При восстановлении старой
PostgreSQL значения `INTEGRATION_ENC_KEY`, `INVITE_CODE_PEPPER` и
`TELEGRAM_IDENTITY_PEPPER` сохраняются byte-for-byte. Для clean bootstrap без
старых данных, напротив, создаются новые production-only значения — см.
[production secrets](./production-secrets.md).

## Первый backup чистого production

Clean launch не требует rsync dev PostgreSQL, MinIO или owner Git repository.
После применения Phase 3 и до выдачи первого production invite проверь, что
production storage чистые, затем запусти backup:

```bash
ssh admin@169.58.116.31 '
set -euo pipefail
sudo -u postgres psql -d minutka -At <<"SQL"
SELECT table_name || E'\t' || row_count
FROM (
  SELECT 'participants' AS table_name, count(*) AS row_count FROM minutka_private.participants
  UNION ALL SELECT 'consents', count(*) FROM minutka_private.consents
  UNION ALL SELECT 'process_schedules', count(*) FROM minutka_private.process_schedules
  UNION ALL SELECT 'ideas', count(*) FROM minutka_private.ideas
  UNION ALL SELECT 'tasks', count(*) FROM minutka_private.tasks
  UNION ALL SELECT 'messages', count(*) FROM minutka_private.messages
) AS counts
ORDER BY table_name;
SQL
sudo systemctl start personal-assistant-backup.service
sudo journalctl -u personal-assistant-backup.service --no-pager -n 100
sudo find /var/backups/personal-assistant -maxdepth 4 -type f -printf "%m %U:%G %p\n" | sort | tail -n 30
sudo cat /var/lib/personal-assistant-observability/backup.last_success
'
```

Для проверки пустого MinIO используй временный `mc` config и runtime
credentials, не печатая их:

```bash
ssh admin@169.58.116.31 '
sudo sh -eu <<"EOF"
config="$(mktemp -d)"
trap "rm -rf $config" EXIT
export MC_CONFIG_DIR="$config"
access="$(cat /run/secrets/assistant/minio_access_key)"
secret="$(cat /run/secrets/assistant/minio_secret_key)"
mc_bin="$(command -v mc || find /nix/store -path '*/bin/mc' -type f -print -quit)"
test -n "$mc_bin"
"$mc_bin" alias set production http://127.0.0.1:9000 "$access" "$secret" >/dev/null
count="$("$mc_bin" find production/personal-assistant --name "*" | wc -l)"
test "$count" -eq 0
echo "Production MinIO is empty"
EOF
'
```

Ожидание перед invite: все перечисленные row counts равны `0`, MinIO не
содержит owner objects, backup содержит PostgreSQL dump и каталог
`minio/personal-assistant/` даже если bucket пуст.

## Restore smoke

`personal-assistant-restore-smoke` по умолчанию выбирает последний завершённый
backup возрастом не меньше 23 часов — вчерашний daily snapshot с допуском на
15-минутный randomized delay. Он:

1. проверяет наличие `minutka.dump` и полного MinIO mirror;
2. восстанавливает dump во временную PostgreSQL database;
3. сравнивает `count(*)` для `participants`, `consents`,
   `process_schedules`, `ideas`, `tasks`, `messages` с production database;
4. зеркалирует live MinIO bucket во временный каталог;
5. сравнивает количество и читаемость всех `*/context/*.md` в live bucket и
   backup; нулевое количество документов допустимо для чистого production;
6. всегда удаляет временную database и temporary directories.

Запуск последнего вчерашнего backup:

```bash
ssh admin@169.58.116.31 \
  'sudo systemctl start personal-assistant-restore-smoke.service && sudo journalctl -u personal-assistant-restore-smoke.service --no-pager -n 100'
```

Проверка конкретного timestamp выполняется через root-only staging, потому что
основные backup-каталоги не выдаются PostgreSQL user напрямую:

```bash
ssh admin@169.58.116.31 '
sudo rm -rf /var/lib/personal-assistant-restore-smoke/backup
sudo install -d -m 0700 -o postgres -g postgres /var/lib/personal-assistant-restore-smoke/backup
sudo cp -a /var/backups/personal-assistant/20260804T001500Z/. \
  /var/lib/personal-assistant-restore-smoke/backup/
sudo chown -R postgres:postgres /var/lib/personal-assistant-restore-smoke/backup
sudo systemctl start personal-assistant-restore-smoke.service
'
```

Smoke сравнивает snapshot с текущим production. Поэтому его запускают до новых
записей либо сразу после выбранного backup. При ожидаемом изменении данных
несоответствие row/document count требует ручной сверки, а не игнорирования.

## Pull-based off-site copy

Source-host создаёт системного пользователя
`personal-assistant-backup-pull`, который входит в read-only группу
`personal-assistant`. Private key хранится только на off-site host. Production
host не имеет credentials, способных удалить off-site snapshots.

На текущем off-site host `v760294.hosted-by-vdsina.com`:

```bash
sudo install -d -m 0750 -o admin -g admin \
  /srv/backups/personal-assistant/{snapshots,logs}
ssh-keyscan -H 169.58.116.31 >> ~/.ssh/known_hosts
```

Создать `/home/admin/.local/bin/pull-personal-assistant-backups`:

```bash
#!/usr/bin/env bash
set -euo pipefail

source_host=169.58.116.31
source_user=personal-assistant-backup-pull
base=/srv/backups/personal-assistant
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
destination="$base/snapshots/$stamp"
previous=""

mkdir -p "$destination"
if [ -L "$base/latest" ]; then
  previous="$(readlink -f "$base/latest")"
fi

options=(-aH --delete --delete-delay --partial)
if [ -n "$previous" ] && [ -d "$previous" ]; then
  options+=(--link-dest="$previous")
fi

rsync "${options[@]}" \
  -e 'ssh -i /home/admin/.ssh/id_ed25519 -o IdentitiesOnly=yes' \
  "$source_user@$source_host:/var/backups/personal-assistant/" \
  "$destination/"
ln -sfn "$destination" "$base/latest"
find "$base/snapshots" -mindepth 1 -maxdepth 1 -type d -mtime +90 -exec rm -rf {} +
```

Первый pull и проверка:

```bash
chmod 0750 /home/admin/.local/bin/pull-personal-assistant-backups
/home/admin/.local/bin/pull-personal-assistant-backups
find /srv/backups/personal-assistant/latest -maxdepth 4 -type f | sort | tail -n 30
```

На off-site host установить oneshot/timer с ежедневным запуском после source
backup, например в `01:30 UTC`, `Persistent=true`, `RandomizedDelaySec=10m`.
После первого запуска зафиксировать `systemctl status`, journal и новый snapshot.
Off-site retention использует snapshot directories с `--link-dest`, а не один
`rsync --delete` mirror: локальное удаление source backups через 14 дней не
удаляет независимую 90-дневную историю.

## Полное восстановление на новом VPS

### 1. Установка и secrets

1. Получить config repository и выбранный off-site timestamp.
2. Обновить Phase 1/2/3 `site.nix`: IP, network, disk и deploy target.
3. Выполнить Phase 1 install, затем Phase 2.
4. Получить новый server age recipient из нового SSH host key.
5. Добавить recipient в `.sops.yaml` и выполнить `sops updatekeys
   secrets/assistant.yaml` owner age key. Сохранить прежние значения
   `INTEGRATION_ENC_KEY`, `INVITE_CODE_PEPPER`, `TELEGRAM_IDENTITY_PEPPER`.
6. Скопировать hardware configuration в Phase 3 и применить Phase 3. Это
   создаёт roles/database, выполняет migrations и provision MinIO bucket.

### 2. Доставка backup и остановка writers

```bash
rsync -aH /srv/backups/personal-assistant/latest/SELECTED_TIMESTAMP/ \
  admin@NEW_SERVER_IP:/tmp/personal-assistant-restore/
ssh admin@NEW_SERVER_IP 'sudo systemctl stop personal-assistant personal-assistant-backup.timer'
```

### 3. PostgreSQL restore

```bash
ssh admin@NEW_SERVER_IP '
set -euo pipefail
backup=/tmp/personal-assistant-restore
sudo -u postgres dropdb --if-exists minutka
sudo -u postgres createdb --owner=minutka_migrator --encoding=UTF8 --locale=C --template=template0 minutka
sudo -u postgres pg_restore \
  --no-owner --role=minutka_migrator --dbname=minutka \
  "$backup/minutka.dump"
'
```

Migrations выполняются до restore только для provisioning roles/database.
После restore повторный migration oneshot обязан быть идемпотентным и проверить
`minutka_meta.schema_migrations`.

### 4. MinIO restore

Получить root credential только через временную root-owned shell из sops
runtime paths и зеркалировать полный backup bucket в уже provisioned versioned
bucket:

```bash
ssh admin@NEW_SERVER_IP '
sudo systemctl stop personal-assistant
sudo sh -eu <<"EOF"
config="$(mktemp -d)"
trap "rm -rf $config" EXIT
export MC_CONFIG_DIR="$config"
root_user="$(cat /run/secrets/assistant/minio_root_user)"
root_password="$(cat /run/secrets/assistant/minio_root_password)"
mc alias set restore http://127.0.0.1:9000 "$root_user" "$root_password" >/dev/null
mc mirror --overwrite --remove \
  /tmp/personal-assistant-restore/minio/personal-assistant/ \
  restore/personal-assistant
EOF
'
```

Не восстанавливать MinIO data-dir поверх работающего процесса: backup является
object-level mirror и восстанавливается через S3 API. Отдельное восстановление
Git source repositories не требуется: owner БЗ всех пользователей уже находится
в восстановленном MinIO bucket.

### 5. Запуск и проверка

```bash
ssh admin@NEW_SERVER_IP '
sudo systemctl start personal-assistant-postgres-migrate personal-assistant-minio-provision personal-assistant
curl -fsS http://127.0.0.1:8787/healthz
sudo systemctl start personal-assistant-restore-smoke.service
sudo systemctl enable --now personal-assistant-backup.timer
'
```

Проверить расписания через service API, не печатая token:

```bash
ssh admin@NEW_SERVER_IP '
set -euo pipefail
set -a
. /run/secrets/rendered/personal-assistant.env
set +a
curl -fsS \
  -H "Authorization: Bearer $MINUTKA_SERVICE_TOKEN" \
  http://127.0.0.1:8787/v1/service/employees/pilot-admin/schedules
'
```

Ожидание: `/healthz` возвращает `{"ok":true}`, schedule response содержит те же
active schedules, restore smoke проходит, новый backup появляется автоматически,
а off-site pull переключён на новый source host.

## Минимальный DR checklist вне production VPS

- config Git repository;
- encrypted `secrets/assistant.yaml`;
- owner age private key;
- свежий off-site timestamp с PostgreSQL dump и полным MinIO mirror;
- private SSH key off-site pull host;
- записанный порядок замены server age recipient и DNS/IP.
