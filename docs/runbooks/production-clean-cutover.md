# Clean production bootstrap and Telegram cutover

## Назначение

Этот runbook запускает production как новый независимый pilot-контур. Он не
является data migration:

- dev PostgreSQL не dump/restore'ится и остаётся без изменений;
- dev MinIO не зеркалируется, не очищается и остаётся без изменений;
- production PostgreSQL создаётся с нуля и получает только штатные migrations;
- production MinIO создаётся с пустым versioned bucket;
- внешние Git-репозитории БЗ пока не импортируются;
- действующий Telegram bot token переключается с dev на production без двух
  одновременно работающих polling consumer'ов.

Новый production invite означает новый participant, повторные consent и
onboarding. Старые profile/history/schedules/knowledge base с dev не переносятся.

## Красная линия: один polling runtime

Telegram long polling не поддерживает безопасную одновременную работу двух
runtime с одним bot token. Production нельзя запускать с действующим token, пока
оператор не подтвердил, что dev runtime с этим token остановлен или уже получил
другого бота.

Команды ниже намеренно разделены на **prepare**, **operator checkpoint** и
**activate**. Не объединяй их в один unattended deploy.

## 1. Подготовить production secrets

Создай отдельные production values для:

- `INTEGRATION_ENC_KEY`;
- `INVITE_CODE_PEPPER`;
- `TELEGRAM_IDENTITY_PEPPER`;
- service/admin/API tokens;
- PostgreSQL credentials;
- MinIO root/application credentials.

Переиспользуется только явно выбранный внешний credential — текущий
`TELEGRAM_BOT_TOKEN`. Dev `.env` целиком не копируется. Процедура sops описана в
[production secrets](./production-secrets.md).

До cutover проверь только структуру ciphertext, не печатая значения:

```bash
cd nixos/phase3-assistant-stack
sops filestatus secrets/assistant.yaml
! grep -Eq 'change-me|REPLACE_ME' secrets/assistant.yaml
```

## 2. Deploy без запуска Telegram runtime

Перед первым deploy зафиксируй текущий production generation. Затем deploy Phase
3 и сразу удерживай приложение остановленным до operator checkpoint:

```bash
cd nixos/phase3-assistant-stack
ssh admin@169.58.116.31 \
  'sudo systemctl mask --runtime --now personal-assistant.service'
./scripts/deploy.sh --dry-activate
./scripts/deploy.sh
```

Runtime mask временный (`/run/systemd`), переживать reboot как постоянная
конфигурация он не должен. После deploy-rs activation проверь mask повторно:
activation может попытаться запустить enabled unit, но runtime mask обязан
заблокировать фактический старт до operator checkpoint. PostgreSQL, MinIO,
migrations, backup и observability при этом можно подготовить и проверить
независимо от Telegram polling.

Проверь:

```bash
ssh admin@169.58.116.31 '
set -euo pipefail
systemctl is-active postgresql minio
systemctl is-failed personal-assistant-postgres-setup personal-assistant-postgres-migrate personal-assistant-minio-provision && exit 1 || true
systemctl is-active personal-assistant && { echo "Runtime unexpectedly active" >&2; exit 1; } || true
curl -fsS http://127.0.0.1:9000/minio/health/ready >/dev/null
'
```

## 3. Доказать чистое состояние production

Проверить прикладные таблицы до первого production invite:

```bash
ssh admin@169.58.116.31 '
sudo -u postgres psql -d minutka -X -v ON_ERROR_STOP=1 <<"SQL"
SELECT table_name, row_count
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
'
```

Каждый `row_count` должен быть `0`. Schema/migration/bootstrap objects ожидаемы
и не являются пользовательскими данными.

Проверить, что полный production bucket не содержит owner objects:

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
echo "Production MinIO owner object count: 0"
EOF
'
```

Если любой count ненулевой, остановись: не очищай production автоматически и не
трогай dev. Сначала выясни происхождение данных.

## 4. Проверить backup чистого контура

Первый backup должен работать без `/home/admin/user_knowledge_base` и создать
только PostgreSQL dump плюс полный MinIO mirror:

```bash
ssh admin@169.58.116.31 '
set -euo pipefail
sudo systemctl start personal-assistant-backup.service
sudo journalctl -u personal-assistant-backup.service --no-pager -n 100
latest="$(sudo find /var/backups/personal-assistant -mindepth 1 -maxdepth 1 -type d -printf "%f\n" | sort | tail -n 1)"
test -n "$latest"
sudo test -s "/var/backups/personal-assistant/$latest/minutka.dump"
sudo test -d "/var/backups/personal-assistant/$latest/minio/personal-assistant"
sudo test ! -e "/var/backups/personal-assistant/$latest/user-knowledge-base.bundle"
sudo cat /var/lib/personal-assistant-observability/backup.last_success
'
```

Полный backup/restore contract описан в
[production backup and restore](./production-backup-restore.md).

## 5. Operator checkpoint: остановить dev polling

Эту часть выполняет оператор на dev самостоятельно. Перед продолжением он
должен подтвердить одно из двух:

1. dev настроен на другого Telegram-бота и перезапущен; либо
2. dev runtime остановлен и больше не опрашивает действующий token.

Dev PostgreSQL и MinIO не останавливаются, не очищаются и не изменяются.
Одного сообщения «поменял token в файле» недостаточно: нужно подтвердить, что
старый процесс завершён/перезапущен и больше не держит polling loop.

Зафиксировать в протоколе:

```text
Dev old-bot polling stopped: <UTC timestamp>
Operator: <name>
Method: <new bot configured | runtime stopped>
Dev PostgreSQL/MinIO untouched: yes
```

## 6. Активировать production polling

Только после operator checkpoint:

```bash
ssh admin@169.58.116.31 '
set -euo pipefail
sudo systemctl unmask --runtime personal-assistant.service
sudo systemctl daemon-reload
sudo systemctl start personal-assistant.service
systemctl is-active personal-assistant.service
curl -fsS http://127.0.0.1:8787/healthz
sudo journalctl -u personal-assistant.service --since "5 minutes ago" --no-pager
'
```

Не запускать dev со старым token для «быстрой проверки»: это нарушает
single-poller contract. Если Telegram сообщает conflict (`getUpdates` terminated
by other getUpdates request), немедленно остановить production и выяснить, какой
старый runtime продолжает polling.

## 7. Новый invite и D.0 без импорта БЗ

Выдай новый production invite через CLI/API. Участник проходит consent и
onboarding заново. Для этого запуска раздел
«Импорт базы знаний тестировщика» в [D.0 runbook](./pilot-scenario-run.md)
пропускается: пустая owner БЗ допустима.

Проверить:

- `/schedule` показывает два автоматически созданных расписания в выбранной
  таймзоне;
- утреннее и вечернее касания приходят с production;
- соответствующие строки `schedule_fires` не имеют `error_code`;
- production smoke/observability зелёные.

Полный двухдневный протокол выполняется по
[D.0 pilot scenario](./pilot-scenario-run.md). Импорт внешних Git repositories и
контрольный вопрос по их содержимому не являются gate этого cutover.

## Rollback Telegram без изменения dev storage

Rollback выполняется только в таком порядке:

1. остановить production polling;
2. убедиться, что production service неактивен;
3. вернуть действующий bot token на dev;
4. запустить/перезапустить dev runtime;
5. проверить, что polling consumer снова ровно один.

```bash
ssh admin@169.58.116.31 '
sudo systemctl stop personal-assistant.service
systemctl is-active personal-assistant.service && exit 1 || true
'
```

После этого оператор переключает dev. Не запускай dev до подтверждённой остановки
production. PostgreSQL и MinIO обоих контуров при Telegram rollback не очищаются
и не синхронизируются. Production данные, появившиеся после invite, остаются на
production для диагностики и последующего решения оператора.

NixOS generation rollback (`./scripts/rollback.sh`) — отдельная операция. Она не
заменяет Telegram sequence: сначала всегда остановить production polling, и
только затем возвращать bot token на dev.
