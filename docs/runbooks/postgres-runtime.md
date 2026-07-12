# PostgreSQL durable runtime

Phase 4.1 uses PostgreSQL as the only persistent/pilot application backend.
`InMemoryWorld` is an executable-spec fixture; `telegram:dev` does not silently
fall back to it.

## Configuration

```dotenv
MINUTKA_RUNTIME_MODE=postgres
DATABASE_URL=postgresql://minutka_runtime:...@localhost:5432/minutka
DATABASE_SSL_MODE=disable # local container only; pilot uses require
INVITE_CODE_PEPPER=<separate random secret>
TELEGRAM_IDENTITY_PEPPER=<separate random secret>
TELEGRAM_BOT_TOKEN=...
TELEGRAM_INVITES=emp_1:one-time-invite
```

Use different migration-owner and application-role credentials in pilot. The
application role must not own schema migrations. Do not log the URL, peppers,
invite codes, Telegram identities, SQL parameters containing personal data, or
raw provider errors.

## Migration and startup

```bash
npm run db:migrate
npm run db:status
npm run telegram:dev
```

The migrator uses a PostgreSQL advisory lock, immutable ordered SQL files, and
SHA-256 checksums in `minutka_meta.schema_migrations`. Startup checks both DB
connectivity and that no migrations are pending; it fails before Telegram
polling starts on failure.

Backup policy and retention periods require explicit pilot approval. Until then,
use only approved limited pilot data. `ProfileStore.deleteEmployeePersonalData`
removes employee-keyed private records through FK cascades; an audit deletion
marker must be separately approved before it is retained.

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
