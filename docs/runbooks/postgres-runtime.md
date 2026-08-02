# PostgreSQL durable runtime

Phase 4.1 uses PostgreSQL as the only persistent/pilot application backend.
`InMemoryWorld` is an executable-spec fixture; `telegram:dev` does not silently
fall back to it. `MINUTKA_RUNTIME_MODE` is deliberately unsupported: Telegram
always starts a PostgreSQL runtime, so an environment typo cannot enable an
unsafe ephemeral mode.

## Local development/test with Docker Compose

`compose.yaml` runs the official `postgres:16-alpine` image with a named volume,
a healthcheck, and a `127.0.0.1`-only port binding. It creates two databases on
first initialisation: `minutka` for runtime state and `minutka_test` for the
persistence suite. Do not point `TEST_DATABASE_URL` to `minutka`: the tests
truncate their database.

1. Create a local environment file and generate secrets:

```bash
cp .env.example .env
chmod 600 .env
# Set POSTGRES_SUPERUSER_PASSWORD, MINUTKA_DB_PASSWORD,
# MINUTKA_MIGRATOR_DB_PASSWORD, INVITE_CODE_PEPPER and
# TELEGRAM_IDENTITY_PEPPER to distinct random values. Generate
# INTEGRATION_ENC_KEY with `openssl rand -base64 32`. Also publish the
# privacy-v2 policy snapshot and set PRIVACY_POLICY_V2_URL to its public URL.
```

2. Initialise PostgreSQL and wait for the healthcheck:

```bash
docker compose up -d postgres
docker compose ps
```

The server uses Docker Compose v2 (`docker compose`); the legacy
`docker-compose` binary is not supported.

The init script runs only for an empty `minutka-postgres-data` volume. Normal
restart/shutdown preserves data:

```bash
docker compose stop postgres
docker compose up -d postgres
```

To reset all local database data deliberately, run:

```bash
docker compose down --volumes
```

## Configuration

```dotenv
DATABASE_URL=postgresql://minutka_runtime:...@127.0.0.1:5432/minutka
TEST_DATABASE_URL=postgresql://minutka_runtime:...@127.0.0.1:5432/minutka_test
MIGRATION_DATABASE_URL=postgresql://minutka_migrator:...@127.0.0.1:5432/minutka
TEST_MIGRATION_DATABASE_URL=postgresql://minutka_migrator:...@127.0.0.1:5432/minutka_test
DATABASE_SSL_MODE=disable # local container only; pilot uses require
INVITE_CODE_PEPPER=<separate random secret>
TELEGRAM_IDENTITY_PEPPER=<separate random secret>
INTEGRATION_ENC_KEY=<exactly 32 random bytes encoded as base64>
PRIVACY_POLICY_V2_URL=https://privacy.example.com/privacy-v2.html
TELEGRAM_BOT_TOKEN=...
TELEGRAM_INVITES=emp_1:one-time-invite
```

Use different migration-owner and application-role credentials in pilot. The
Compose bootstrap creates `minutka_migrator` as database/schema owner and
`minutka_runtime` as the non-owner application role. `db:migrate` uses
`MIGRATION_DATABASE_URL`; runtime uses `DATABASE_URL`. The application role
receives `USAGE` on application schemas, DML on runtime tables, and read-only
`SELECT` on `minutka_meta.schema_migrations` for the startup status check. Do
not log the database URL, peppers, encryption key, invite codes, Telegram
identities, SQL parameters containing personal data, or raw provider errors.
`INTEGRATION_ENC_KEY` never crosses the Node.js process boundary; PostgreSQL
stores only the AES-256-GCM ciphertext.

`PRIVACY_POLICY_V2_URL` is mandatory deployment configuration, with no repository
fallback. Before accepting owners, publish the exact `privacy-v2` policy snapshot
at an anonymously accessible HTTPS URL and verify it from outside the deployment
network. A normal canonical URL must include `privacy-v2` as a path segment or
filename (for example `/privacy-v2.html`). GitHub and raw GitHub document URLs
are accepted only when the document is pinned to a full 40-character commit SHA;
mutable references such as `blob/main` and tags are rejected at startup. Query
parameters, fragments, embedded credentials, and non-HTTPS URLs are rejected.
Changing the linked policy content requires publishing a new privacy version and
updating both `currentPrivacyVersion` and its corresponding environment variable;
do not replace content in place under an already accepted version.

При старте runtime проверяет поддержку атомарного conditional create в MinIO и
временно создаёт объект `.runtime-probes/conditional-create-*`. После проверки
runtime удаляет созданную версию probe-объекта через `forceDelete`; сбой очистки
попадает в operational warning только с именем класса ошибки. Префикс
`.runtime-probes/` не содержит пользовательских данных. Его можно включить в
lifecycle-правило как защитную очистку накопившихся probe-объектов, но правило
не заменяет мониторинг warning и устранение причины ошибок `removeObject`.

## Migration and startup

```bash
# Export .env because migration/test scripts intentionally do not load it.
set -a; . ./.env; set +a
# db:migrate requires MIGRATION_DATABASE_URL; runtime does not use it.
npm run db:migrate
npm run db:status
npm run verify:persistence
```

`db:migrate` reports only migrations applied by this invocation. `pending` is
therefore always empty after a successful migration run. `db:status` is the
command that reports migrations still awaiting application.

## Start Telegram and issue an invite

Start the bot:

```bash
npm run telegram:dev
```

For pilot participants, issue an invite through the running operator API. This
path requires no `.env` edit and no runtime restart:

```bash
export MINUTKA_API_URL=http://127.0.0.1:8787
export MINUTKA_API_TOKEN="$MINUTKA_ADMIN_TOKEN"
export TELEGRAM_BOT_USERNAME=<bot_username_without_at>
npm run cli -- admin invite --employee emp_001
npm run cli -- admin list-participants
```

`admin invite` generates a 32-byte base64url code and prints the ready Telegram
deep-link. The link is shown once and cannot be recovered: PostgreSQL stores
only `participants.invite_code_digest`. If it is lost, delete the unused
participant with the normal owner-delete procedure and issue a new invite.
`list-participants` exposes only employee ID, onboarding status, and timestamps;
it does not expose profile names, timezones, chat IDs, or Telegram identities.

`TELEGRAM_INVITES` remains a dev-only bootstrap convenience. Keep it empty in
pilot environments. The env path holds plaintext codes, reissues seeds on every
startup, has no inventory or expiry, and requires an edit plus restart for each
participant. If used for isolated local development, keep the populated `.env`
uncommitted and never expose or reuse its codes.

The migrator uses a PostgreSQL advisory lock, immutable ordered SQL files, and
SHA-256 checksums in `minutka_meta.schema_migrations`. Startup checks both DB
connectivity and that no migrations are pending; it fails before Telegram
polling starts on failure.

Backup policy and retention periods require explicit pilot approval. Until then,
use only approved limited pilot data. `minutka_private.consents` is the current
consent snapshot: accepting a new privacy version replaces the previous row.
For the limited pilot, prior accepted versions exist only as `consent_accepted`
events in `minutka_audit.events`, subject to the audit retention and deletion
lifecycle; there is no append-only consent ledger. `ProfileStore.deleteEmployeePersonalData`
removes employee-keyed private records, including those audit events, through FK
cascades and retains only an anonymous `employee_data_deleted` marker (no
employee ID, transport identity, or personal content).

## Расписания ежедневных касаний

После завершения онбординга application создаёт владельцу два расписания один
раз: `day_focus` на 09:00 и `evening_reflection` на 19:00 в IANA-таймзоне из
профиля. Если у владельца уже есть хотя бы одна строка расписания, автоматическое
провижининг ничего не создаёт и не меняет: персональные правки в PostgreSQL имеют
приоритет.

Проверить расписания конкретного участника:

```sql
SELECT schedule_id, process_id, time_of_day, timezone, enabled, next_fire_at
FROM minutka_private.process_schedules
WHERE user_id = 'emp_001'
ORDER BY time_of_day, schedule_id;
```

Для участников, завершивших онбординг до появления автоматического провижининга,
один раз запустите идемпотентный backfill с runtime-учётными данными:

```bash
set -a; . ./.env; set +a
npm run pilot:schedules:backfill
```

Команда выбирает только `profile_completed` без единого расписания и создаёт им
те же два дефолта в таймзоне профиля. Повторный запуск безопасен. Она не меняет
владельцев, у которых уже есть хотя бы одна строка.

Временно выключить все ежедневные касания одному владельцу:

```sql
UPDATE minutka_private.process_schedules
SET enabled = false, updated_at = now()
WHERE user_id = 'emp_001';
```

Вернуть касания можно аналогичным `UPDATE ... SET enabled = true`; сохранённые
время, таймзона и `next_fire_at` при этом не перезаписываются.

## Restart smoke

1. Migrate an empty approved database.
2. Start Telegram, redeem a seed invite, accept consent, and complete profile.
3. Send two messages in one thread and submit feedback.
4. Stop the process without clearing PostgreSQL, then restart it.
5. Confirm `/start` resolves the existing binding, chat context includes the
   bounded earlier turn, and feedback/insights remain present.
6. Inspect audit rows: they must not contain invite codes/digests, Telegram IDs,
   raw prompt/message/response, provider payloads, or stack traces.

Run the PostgreSQL contract suite only against `TEST_DATABASE_URL`, never a
development or pilot database.
