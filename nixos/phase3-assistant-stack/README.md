# Phase 3: production assistant stack

Третий этап добавляет к operational baseline `sops-nix`, Nix-пакет приложения,
systemd-сервис ассистента, оба durable storage, daily backup, restore smoke,
read-only source account для off-site pull и loopback-only observability.
PostgreSQL доступен только через
unix socket; MinIO API и Console слушают только loopback.

## Что обеспечивает этап

- единственный зашифрованный bundle `secrets/assistant.yaml` в git;
- расшифровка хостовым `/etc/ssh/ssh_host_ed25519_key` без отдельного server age key;
- runtime-файлы только в `/run/secrets*`, owner `personal-assistant`, mode `0400`;
- systemd-совместимый `/run/secrets/rendered/personal-assistant.env` без кавычек
  и комментариев;
- evaluation failure при отсутствующем, незашифрованном bundle или видимом
  плейсхолдере;
- `pkgs.buildNpmPackage` с pinned `npmDepsHash`, без отдельного build-step;
- self-contained runtime в `/nix/store/.../lib/personal-assistant` с
  `package.json`, `node_modules`, `src`, `vault/assistant` и `migrations`;
- system user, restart через 5 секунд, journald и systemd hardening;
- reviewable non-secret runtime limits and token-price settings in the NixOS
  module; journal storage capped at 512 MiB;
- PostgreSQL 16 без TCP, отдельные `minutka_migrator`/`minutka_runtime`,
  идемпотентный database setup и migration oneshot до приложения;
- MinIO provisioning oneshot: bucket `personal-assistant`, versioning Enabled и
  least-privilege policy/user; root credential не попадает в runtime;
- MinIO data dir и capacity budget из `site.storage.minio`, с обязательным
  filesystem reserve не меньше 5 GiB;
- daily `pg_dump -Fc`, version-aware MinIO mirror и Git bundle/worktree snapshot
  source knowledge base в `/var/backups/personal-assistant/<UTC timestamp>`;
- 14-day local retention, `backup.last_success`, restore smoke и отдельный
  SSH account для pull-based off-site snapshots;
- smoke каждые 15 минут для PostgreSQL, MinIO, приложения и `/healthz`;
- `node_exporter` только на loopback с textfile-метриками service/backup/smoke,
  schedule fires, monthly usage и storage/artifact capacity без owner labels.

Подготовка и проверка bundle описаны в
[`secrets/README.md`](secrets/README.md). Ротация secrets — в
[`../../docs/runbooks/production-secrets.md`](../../docs/runbooks/production-secrets.md),
backup, off-site pull и полное восстановление — в
[`../../docs/runbooks/production-backup-restore.md`](../../docs/runbooks/production-backup-restore.md),
smoke, SSH-туннель и operator thresholds — в
[`../../docs/runbooks/production-observability.md`](../../docs/runbooks/production-observability.md).

## Deploy

Перед deploy на хосте уже должна быть применена Phase 2, а production
`ssh-ed25519` host key не должен меняться после шифрования bundle. До приёма
pilot traffic смонтируй durable filesystem в `site.storage.minio.dataDir` и
проверь, что его фактическая ёмкость не меньше `capacityBytes`. Текущий budget —
55 GiB: 45 GiB global artifact hard limit, 5 GiB application reserve и 5 GiB
filesystem reserve. MinIO нельзя оставлять на маленьком root volume без
capacity-monitoring; collector публикует free bytes, use percent и ранний soft
threshold до filesystem reserve.

```bash
./scripts/deploy.sh --dry-activate
./scripts/deploy.sh
```

Локально пакет можно собрать отдельно:

```bash
nix build .#personal-assistant
```

Проверка после deploy:

```bash
sudo find /run/secrets \
  -type f -printf '%m %U:%G %p\n'
sudo systemctl status postgresql minio \
  personal-assistant-postgres-setup \
  personal-assistant-postgres-migrate \
  personal-assistant-minio-provision \
  personal-assistant \
  personal-assistant-backup.timer \
  personal-assistant-smoke.timer \
  personal-assistant-observability-collector.timer \
  prometheus-node-exporter.service
sudo systemctl show personal-assistant \
  -p EnvironmentFiles -p WorkingDirectory -p Restart -p RestartUSec
sudo journalctl -u personal-assistant --since today
sudo systemctl start personal-assistant-backup.service
sudo find /var/backups/personal-assistant -maxdepth 3 -type f | sort | tail -n 30
sudo systemctl start personal-assistant-smoke.service
sudo systemctl start personal-assistant-observability-collector.service
curl -fsS http://127.0.0.1:9100/metrics | grep '^personal_assistant_'
sudo ss -lntp | grep -E '127\.0\.0\.1:(9000|9001|9100)'
sudo -u postgres psql -d postgres -Atc \
  "select rolname, rolsuper, rolcreatedb, rolcreaterole from pg_roles where rolname in ('minutka_runtime','minutka_migrator') order by rolname"
```

Ожидаются `0400 personal-assistant:personal-assistant` для application/bootstrap
secrets, кроме PostgreSQL role passwords и MinIO app credential
(`0440 personal-assistant:postgres`, чтобы peer-authenticated setup/restore
smoke могли читать их), и `0400 minio:minio` только для
`minio-root.env`; `WorkingDirectory`
должен указывать на пакет в Nix store. Для smoke restart:

```bash
pid="$(systemctl show -p MainPID --value personal-assistant)"
sudo kill -9 "$pid"
timeout 10 sh -c 'until systemctl is-active --quiet personal-assistant; do sleep 1; done'
```

Содержимое секретов в терминал и журналы не выводится. Версия приложения входит
в то же NixOS generation, поэтому `./scripts/rollback.sh` откатывает сервис и
хост вместе.

## Durable storage contract

MinIO — durable storage, не cache. После knowledge-base cutover он является
единственным source of truth owner knowledge base; двусторонней синхронизации с
Git workspace нет. Канонические object prefixes:

```text
{owner}/context/*
{owner}/cas/sha256/**
```

`{owner}/inbox/*` не provisionится как отдельный namespace. Временные ingress
blobs могут существовать как внутренние object keys приложения, но не являются
канонической knowledge-base зоной. Artifact CAS хранится под
`{owner}/cas/sha256/**`.

Application startup выполняется только после provisioning и migration oneshot.
Затем сам runtime вызывает read-only readiness contract `prepareMinioBucket`:
проверяет наличие bucket, `Enabled` versioning и реальное соблюдение conditional
`If-None-Match: *`. При нарушении любого из условий процесс завершается до
приёма HTTP/Telegram traffic.

Runtime PostgreSQL role не владеет database/schema: owner —
`minutka_migrator`, а миграции явно выдают runtime только `USAGE`, DML и чтение
migration status. MinIO application credential имеет только bucket/object
операции и не может создавать пользователей или менять policy. Backup/restore
PostgreSQL и MinIO остаются в INF.5.
