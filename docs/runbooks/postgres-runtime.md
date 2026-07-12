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
# TELEGRAM_IDENTITY_PEPPER to distinct random values.
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
TELEGRAM_BOT_TOKEN=...
TELEGRAM_INVITES=emp_1:one-time-invite
```

Use different migration-owner and application-role credentials in pilot. The
Compose bootstrap creates `minutka_migrator` as database/schema owner and
`minutka_runtime` as the non-owner application role. `db:migrate` uses
`MIGRATION_DATABASE_URL` (or `DATABASE_URL` when deliberately omitted); runtime
uses `DATABASE_URL`. The application role receives `USAGE` on application
schemas, DML on runtime tables, and read-only `SELECT` on
`minutka_meta.schema_migrations` for the startup status check. Do not log the URL, peppers,
invite codes, Telegram identities, SQL parameters containing personal data, or
raw provider errors.

## Migration and startup

```bash
# Export .env because migration/test scripts intentionally do not load it.
set -a; . ./.env; set +a
# db:migrate requires MIGRATION_DATABASE_URL; runtime does not use it.
npm run db:migrate
npm run db:status
npm run verify:persistence
npm run telegram:dev
```

The migrator uses a PostgreSQL advisory lock, immutable ordered SQL files, and
SHA-256 checksums in `minutka_meta.schema_migrations`. Startup checks both DB
connectivity and that no migrations are pending; it fails before Telegram
polling starts on failure.

Backup policy and retention periods require explicit pilot approval. Until then,
use only approved limited pilot data. `ProfileStore.deleteEmployeePersonalData`
removes employee-keyed private records through FK cascades and retains only an
anonymous `employee_data_deleted` marker (no employee ID, transport identity,
or personal content).

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
