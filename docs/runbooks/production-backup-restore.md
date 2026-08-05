# Production backup and restore

## Назначение

Production-host ежедневно сохраняет три источника durable-данных в
`/var/backups/personal-assistant/<UTC timestamp>/`:

- `minutka.dump` — custom-format `pg_dump -Fc` PostgreSQL;
- `minio/` — object-level mirror bucket MinIO;
- `user-knowledge-base.bundle`, `user-knowledge-base.head` и
  `user-knowledge-base-worktree/` — самодостаточный Git bundle и exact worktree
  snapshot исходного owner knowledge-base repository.

Локальный retention — 14 дней. Успешный запуск записывает Unix timestamp в
`/var/lib/personal-assistant-observability/backup.last_success`; незавершённый
каталог имеет suffix `.incomplete` и не считается бэкапом.

## Что не входит в backup

Data backup намеренно не содержит:

- git-репозиторий конфигурации personal-assistant;
- зашифрованный `nixos/phase3-assistant-stack/secrets/assistant.yaml` как
  отдельную копию вне config repository;
- private owner age key;
- `/etc/ssh/ssh_host_ed25519_key`, который является server age identity;
- полный disk/VPS snapshot и незакоммиченные изменения knowledge-base.

Для disaster recovery эти артефакты хранятся отдельно от production VPS. Без
owner age key нельзя пере-зашифровать secrets под новый host key; без ciphertext
bundle приходится перевыпускать внешние credentials, а стабильные peppers и
`INTEGRATION_ENC_KEY` без data migration менять нельзя.

## Подготовка перед первым запуском

На production-host должен существовать owner-only Git repository по пути из
`site.backup.knowledgeBasePath`:

```bash
sudo install -d -m 0750 -o admin -g personal-assistant /home/admin/user_knowledge_base
rsync -a --delete /home/admin/user_knowledge_base/ \
  admin@169.58.116.31:/home/admin/user_knowledge_base/
ssh admin@169.58.116.31 '
sudo chmod 0710 /home/admin
sudo chgrp -R personal-assistant /home/admin/user_knowledge_base
sudo find /home/admin/user_knowledge_base -type d -exec chmod 0750 {} +
sudo find /home/admin/user_knowledge_base -type f -exec chmod 0640 {} +
git -C /home/admin/user_knowledge_base status --short
'
```

Рабочее дерево должно быть чистым: backup fail-closed проверяет staged/unstaged
изменения, затем фиксирует Git refs и exact worktree snapshot.

Применить Phase 3 и запустить первый backup:

```bash
cd nixos/phase3-assistant-stack
./scripts/deploy.sh
ssh admin@169.58.116.31 \
  'sudo systemctl start personal-assistant-backup.service'
```

Проверка:

```bash
ssh admin@169.58.116.31 '
set -euo pipefail
systemctl list-timers personal-assistant-backup.timer --all
sudo journalctl -u personal-assistant-backup.service --no-pager -n 100
sudo find /var/backups/personal-assistant -maxdepth 3 -type f -printf "%m %U:%G %p\n" | sort | tail -n 30
sudo cat /var/lib/personal-assistant-observability/backup.last_success
'
```

## Restore smoke на вчерашнем backup

`personal-assistant-restore-smoke` по умолчанию выбирает последний завершённый
backup возрастом не меньше 23 часов — вчерашний daily snapshot с допуском на
15-минутный randomized delay. Он:

1. восстанавливает `minutka.dump` во временную PostgreSQL database;
2. сравнивает `count(*)` для `participants`, `consents`,
   `process_schedules`, `ideas`, `tasks`, `messages` с production database;
3. зеркалирует live MinIO bucket во временный каталог и сравнивает количество
   читаемых `*/context/*.md` с копией `/proc/context` в backup;
4. выполняет `git bundle verify` для source knowledge base;
5. всегда удаляет временную database и temporary directories.

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

Smoke сравнивает snapshot с текущим production. Поэтому его запускают до
новых записей либо выбирают вчерашний backup сразу после daily backup; при
ожидаемом изменении данных несоответствие row/document count требует ручной
сверки, а не игнорирования.

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
runtime paths и зеркалировать backup в уже provisioned versioned bucket:

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
mc mirror --overwrite --remove /tmp/personal-assistant-restore/minio/ restore/personal-assistant
EOF
'
```

Не восстанавливать MinIO data-dir поверх работающего процесса: backup является
object-level mirror и восстанавливается через S3 API.

### 5. Knowledge-base source repository

```bash
ssh admin@NEW_SERVER_IP '
set -euo pipefail
sudo rm -rf /home/admin/user_knowledge_base
sudo -u admin git clone /tmp/personal-assistant-restore/user-knowledge-base.bundle /home/admin/user_knowledge_base
expected="$(cat /tmp/personal-assistant-restore/user-knowledge-base.head)"
actual="$(sudo -u admin git -C /home/admin/user_knowledge_base rev-parse HEAD)"
test "$actual" = "$expected"
sudo -u admin rsync -a --delete \
  /tmp/personal-assistant-restore/user-knowledge-base-worktree/ \
  /home/admin/user_knowledge_base/
sudo -u admin git -C /home/admin/user_knowledge_base diff --quiet
sudo chmod 0710 /home/admin
sudo chgrp -R personal-assistant /home/admin/user_knowledge_base
sudo find /home/admin/user_knowledge_base -type d -exec chmod 0750 {} +
sudo find /home/admin/user_knowledge_base -type f -exec chmod 0640 {} +
'
```

### 6. Запуск и проверка

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
- свежий off-site timestamp со всеми тремя data sources;
- private SSH key off-site pull host;
- записанный порядок замены server age recipient и DNS/IP.
