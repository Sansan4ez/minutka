# HTTP Application API runtime (Phase 4.2)

## Start

1. Prepare PostgreSQL and apply migrations:

```bash
npm run db:migrate
```

2. Configure `.env` with `DATABASE_URL`, the two persistence peppers, and at
least one static credential. Generate tokens with `openssl rand -hex 32`.

```dotenv
MINUTKA_API_HOST=127.0.0.1
MINUTKA_API_PORT=8787
# For a TLS reverse-proxy deployment only, also set both:
# MINUTKA_API_ALLOW_NON_LOOPBACK=true
# MINUTKA_API_TRUST_PROXY=true
MINUTKA_ADMIN_TOKEN=<64-or-more-character-token>
MINUTKA_SERVICE_TOKEN=<64-or-more-character-token>
MINUTKA_EMPLOYEE_TOKENS=emp_pilot:<64-or-more-character-token>
TELEGRAM_MODE=disabled
```

3. Start the shared runtime:

```bash
npm run serve
```

The listener defaults to loopback. A non-loopback address requires both
`MINUTKA_API_ALLOW_NON_LOOPBACK=true` and `MINUTKA_API_TRUST_PROXY=true`, and
must be placed behind a TLS-terminating reverse proxy that overwrites
`X-Forwarded-For`. Node does not terminate TLS in this phase.

Enable Telegram polling explicitly only after supplying both
`TELEGRAM_BOT_TOKEN` and `MINUTKA_SERVICE_TOKEN`:

```bash
TELEGRAM_MODE=polling npm run serve
```

## CLI

The CLI is a separate process and never creates a runtime or accesses PostgreSQL
directly. Employee identity comes from the bearer token, never `--employee`.

```bash
export MINUTKA_API_URL=http://127.0.0.1:8787
export MINUTKA_API_TOKEN=<employee-token>
npm run cli -- employee profile
npm run cli -- employee chat --thread workday-1 --text 'План на сегодня'
```

Use an operator token only for privileged commands:

```bash
export MINUTKA_API_TOKEN=<admin-token>
npm run cli -- admin issue-invite --employee emp_pilot --invite "$(openssl rand -hex 24)"
```

## Pilot-auth security notes

Static bearer tokens are a Stage-1 pilot baseline, not an identity-provider
replacement. Tokens are compared using SHA-256 digests and `timingSafeEqual`,
are never emitted to access logs, and must be unique per principal/environment.
The API returns request IDs and redacted errors only; it does not return SQL,
provider payloads, Telegram identifiers, raw chat text in logs, or stack traces.

Unauthenticated invite opening is rate-limited per source IP. In non-loopback
deployments, `MINUTKA_API_TRUST_PROXY=true` is mandatory and uses the first
`X-Forwarded-For` value; only enable it when the trusted reverse proxy is the
sole direct peer and overwrites that header. Never enable it for direct
internet traffic. All mutable employee and operator operations are rate-limited
per principal; Telegram service-plane operations are limited per employee scope,
so one active chat cannot exhaust the entire bot's bucket. JSON request bodies
are limited to 64 KiB.
