# HTTP Application API runtime (Phase 4.2)

> **Унаследовано от персонального ассистента.** Команды и стек служат операционным фундаментом клона; хосты, unit names и пути должны быть перенастроены под «Минутку». Живые продуктовые и privacy-решения: [RFC «Минутки»](../architecture/rfc-minutka-tenancy-and-reporting.md).

## Справочник рутин

Для activity extractor и отчёта v2 оператор может подключить каталог `routine-directory.<company>.json` через отдельный каталог файлов:

```dotenv
ROUTINE_DIRECTORY_DIR=/srv/minutka/operator/routine-directories
```

При старте runtime читает только активные файлы вида `routine-directory.<company>.json`. Версионированные копии `routine-directory.<company>.<version>.json` хранят историю и не являются fallback-источником. Каждый активный файл проверяется как `minutka-routine-directory/v1`: `version` — монотонное целое без префикса (`"1"`, `"2"`, …), а компания, provenance, уникальные ids, quick win и tombstones должны быть корректны. Tombstones `routine-directory.<company>.tombstones.json` должны лежать рядом с активным файлом и копироваться вместе с ним. Некорректный найденный файл останавливает startup с безопасной ошибкой; исправьте его и перезапустите runtime.

Если `ROUTINE_DIRECTORY_DIR` не задан, каталог не существует или для компании нет файла, runtime запускается без секции справочника. Activity transaction сохраняет свободный `routineLabel` без `routineId`, а отчёт всё равно строит coverage и time budget; имена рутин в client DTO появляются только после передачи проверенного справочника команде отчёта. Отсутствие файла не является основанием для создания каталога или записи в corpus. Проверку и предложение остатка выполняйте командами [`routine-directory validate`](company-report-export.md#1-проверить-справочник) и [`routine-directory suggest`](company-report-export.md#3-предложить-записи-для-остатка).

Файлы справочника читаются один раз при старте runtime и затем используются из памяти. После purge очищенная версия записывается и в `routine-directory.<company>.<version>.json`, и в новый активный `routine-directory.<company>.json`; после purge или замены версии файла нужен обязательный рестарт (`systemctl restart <unit>`). В логе старта проверьте строку `routine directory loaded`, содержащую компанию, версию и число записей; имена записей в неё не попадают.

Справочник и tombstones содержат операторские данные и не должны попадать в репозиторий, corpus, traces, model prompt или client artifact без предусмотренной редактуры.


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

Use an operator token only for privileged commands:

```bash
export MINUTKA_API_URL=http://127.0.0.1:8787
export MINUTKA_API_TOKEN=<admin-token>
export TELEGRAM_BOT_USERNAME=<bot_username_without_at>
npm run cli -- admin invite --employee emp_pilot --company <company_id> --group <group_id>
npm run cli -- admin list-participants --company <company_id> --group <group_id>
```

`admin invite` prints the ready deep-link once. PostgreSQL stores only the code
digest, so a lost link cannot be recovered; delete the unused participant and
issue a new invite. `admin list-participants` requires company/group scope and
returns only employee ID, onboarding status, nullable local `lastTouchOn`, and
`active` / `lagging` / `dropped_off`; it never returns content or insights.
`TELEGRAM_INVITES` is dev-only and must remain empty in pilot configuration.

The CLI is a separate process and never creates a runtime or accesses PostgreSQL
directly. Employee identity comes from the bearer token, never `--employee`.

Before running employee commands, register that employee's token in the runtime
`.env` file via `MINUTKA_EMPLOYEE_TOKENS` (for example,
`MINUTKA_EMPLOYEE_TOKENS=emp_pilot:<employee-token>`) and restart `npm run serve`
after changing it. Configure the same token in the CLI process:

```bash
export MINUTKA_API_URL=http://127.0.0.1:8787
export MINUTKA_API_TOKEN=<employee-token>
```

Employee-token full cycle:

```bash
npm run cli -- employee open-invite --invite <code>
npm run cli -- employee accept-consent --yes
npm run cli -- employee complete-onboarding --role "аналитик" \
  --task "отчёты" --persona support --ai-level beginner
npm run cli -- employee profile
npm run cli -- employee chat --thread workday-1 --text "План на сегодня"
npm run cli -- employee insights --kind routine_pattern
npm run cli -- employee feedback --target-message <id> --thread workday-1 --rating positive
```
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
