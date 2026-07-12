# Этап 4.2: HTTP Application API and Shared Runtime — authenticated HTTP transport, transport-neutral SDK и standalone CLI

> **Статус:** proposed.
> **Родительский план:** [time-agent-mastra-plan.md](./time-agent-mastra-plan.md)
> **Предыдущий этап:** [phase-4.1-durable-runtime-foundation.md](./phase-4.1-durable-runtime-foundation.md)
> **Стартовый тег:** `phase-4.1-durable-runtime-foundation`
> **Целевой тег:** `phase-4.2-http-application-api`
> **Архитектурные основания:**
> - [RFC: HTTP application API and transport-neutral SDK](../architecture/rfc-http-application-api.md)
> - [RFC: runtime projections for the Agent Vault](../architecture/rfc-runtime-projections.md)
> - [Minutka agent vault architecture](../architecture/agent-vault.md)
> - [PostgreSQL runtime runbook](../runbooks/postgres-runtime.md)

---

## 1. Цель этапа

Ввести настоящий, версионированный, аутентифицированный HTTP application API перед `MinutkaService`, чтобы standalone CLI из отдельного OS-процесса, Telegram shell и будущая web-панель работали с одним живым runtime и одним persistent PostgreSQL state:

```text
Telegram polling shell ─┐
Standalone CLI ─────────┼── HTTP loopback / HTTPS ── HTTP router + auth
Web panel (позже) ──────┘                                 │ trusted principal + scope
                                                          ▼
                                                   MinutkaService
                                                          ▼
                                        PostgreSQL application stores (Phase 4.1)
```

Главный принцип этапа:

> **HTTP router владеет только transport-заботами: аутентификация, derivation trusted principal/scope, парсинг/валидация DTO и error mapping. `MinutkaService` не знает про HTTP, токены и Telegram identity. Identity сотрудника выводится из authenticated principal, а не из caller-controlled поля `employeeId`.**

Phase 4.2 не добавляет продуктовой функциональности и не решает заново storage/projection/conversation ownership — она использует готовые contracts, stores и composition Phase 4.1. Deployment Stage 1 по RFC: один Node.js процесс хостит HTTP listener и Telegram polling; это deployment-решение, а не in-process интеграция клиентов.

---

## 2. Текущее состояние и разрывы

Что уже есть после Phase 4.1 (упрощает этап):

- `MinutkaClient` уже сделан фасадом над портом `MinutkaTransport`; `createInProcessServer` возвращает объект, структурно совместимый с этим портом.
- Telegram shell уже вызывает use cases только через `MinutkaClient`, а не через `MinutkaService` напрямую; transport identity резолвится через `TelegramSessionStore`.
- `createPostgresRuntime` — единый composition root с fail-fast config/migration checks и graceful shutdown.
- Typed persistence errors (`PersistenceError` с кодами `invite_not_found`, `persistence_conflict` и т.д.) готовы к mapping на HTTP statuses.

Разрывы, которые закрывает Phase 4.2:

1. **Нет process boundary.** `src/server/http/in-process-server.ts` — не HTTP listener; отдельный терминал (`minutka employee profile ...`) не может увидеть состояние работающего бота.
2. **SDK связан с application-типами.** `MinutkaTransport` в `src/client/sdk/minutka-client.ts` импортирует input-типы из `application/minutka-service.ts`; нет transport-neutral contracts module.
3. **`employeeId` — caller-controlled поле.** Все SDK-операции и CLI-команды принимают `--employee`; произвольный клиент мог бы выбрать чужого сотрудника, поменяв JSON-поле. До сетевого transport это было приемлемо, после — нет.
4. **Нет principal/authorization модели.** Нет разделения employee / operator / service identity и связанных проверок ownership на серверной границе.
5. **CLI не является executable entrypoint.** `runMinutkaCli` вызывается только из spec harness; нет бинарной точки входа с `MINUTKA_API_URL`/`MINUTKA_API_TOKEN`.
6. **`listInsights` без scope.** Текущий contract позволяет читать insights без `employeeId` (все записи) — это нельзя выносить на network boundary.

---

## 3. Definition of Done

### 3.1 Contracts и SDK

- [ ] Создан transport-neutral contracts module `src/contracts/minutka-api.ts`: Zod request/response schemas, DTO-типы, имена операций, error envelope и allow-listed error codes.
- [ ] Contracts module не импортирует HTTP-фреймворк, Telegraf, Commander, `InMemoryWorld`, `MinutkaService` и `server/http`.
- [ ] `MinutkaClient` валидирует запрос/ответ схемами contracts module; `client/sdk` не импортирует типы из `server/http` и из `application/minutka-service`.
- [ ] Employee-операции SDK (`chat`, `getProfile`, `acceptConsent`, `completeOnboarding`, `listInsights`, `submitFeedback`) не принимают `employeeId` в request DTO: identity привязывается transport-ом.
- [ ] `InProcessMinutkaTransport` создаётся с явным principal и подставляет trusted `employeeId` при вызове `MinutkaService`; `createInProcessServer` остаётся deprecated alias только для миграции specs.
- [ ] Реализован `HttpMinutkaTransport` (fetch-based) с bearer auth, request timeout и разбором error envelope в typed client errors.

### 3.2 HTTP server

- [ ] Реализован HTTP listener (`node:http`) с explicit route table под namespace `/v1`.
- [ ] Аутентификация: bearer tokens из env, timing-safe сравнение, principal kinds `employee | operator | service`.
- [ ] Все employee-операции доступны как `/v1/me/*` и выводят `employeeId` из principal; body/query не содержат employee identifier для этих routes.
- [ ] Service plane `/v1/service/employees/:employeeId/*` и `/v1/service/telegram/*` доступен только service principal (Telegram shell).
- [ ] `POST /v1/admin/invites` доступен только operator principal.
- [ ] `POST /v1/onboarding/invites/open` — unauthenticated, но rate-limited.
- [ ] Server-side Zod-валидация body/params на границе доверия (независимо от SDK-валидации); неизвестные поля отклоняются.
- [ ] Error envelope `{ "error": { "code", "message", "requestId" } }`; mapping `PersistenceError` → 4xx; stack traces, SQL/provider errors, invite codes и Telegram IDs не попадают в ответы и логи.
- [ ] `GET /healthz` без auth: `select 1` + migration status как boolean, без database metadata.
- [ ] Request size limit, request id в ответе, per-IP rate limit на unauthenticated route, таймауты.
- [ ] Listener по умолчанию слушает `127.0.0.1`; non-loopback bind требует явной env-переменной и документирован как «только за TLS-terminating reverse proxy».

### 3.3 CLI

- [ ] Добавлен executable entrypoint `src/client/cli/main.ts` (`npm run cli -- ...`), конструирующий `HttpMinutkaTransport` из `MINUTKA_API_URL`/`MINUTKA_API_TOKEN` и вызывающий существующий `runMinutkaCli`.
- [ ] Employee-команды CLI не принимают и не требуют `--employee`: identity определяется токеном.
- [ ] Отдельная privileged группа `minutka admin` (issue-invite и другие операции operator plane) принимает `--employee` там, где endpoint это авторизует.
- [ ] CLI, запущенный в отдельном OS-процессе, видит то же состояние (profile/thread/insights/feedback), что и работающий серверный процесс, и никогда не создаёт собственный `InMemoryWorld`.

### 3.4 Composition и Telegram

- [ ] Создан composition root `serve`: PostgreSQL runtime → HTTP listener → (опционально, explicit env) Telegram polling; fail-fast на config/migration/listen errors до внешнего traffic.
- [ ] Telegram shell вызывает use cases через `MinutkaClient` + `HttpMinutkaTransport` с service credential на loopback URL — тот же authorization/serialization путь, что у внешних клиентов.
- [ ] `TelegramSessionStore` остаётся приватной границей процесса (identity mapping не выносится в public API).
- [ ] Graceful shutdown в порядке: stop HTTP accept → stop Telegram polling → drain in-flight → close pool.
- [ ] `MinutkaService` не имеет HTTP/framework/auth зависимостей (проверяется review + import lint в specs).

### 3.5 Verification

- [ ] Все существующие executable specs зелёные на principal-bound in-process transport.
- [ ] Добавлен `SPEC-HTTP-API-001`: auth, authorization, cross-employee denial, error mapping, unknown-field rejection.
- [ ] Добавлен `SPEC-CLI-HTTP-001`: реальный HTTP listener на ephemeral port + CLI через `HttpMinutkaTransport` поверх in-memory runtime — hermetic, без PostgreSQL и LLM.
- [ ] `npm run typecheck`, `npm run specs`, `npm run verify`, `nix run .#verify` проходят без PostgreSQL и сети наружу.
- [ ] `npm run verify:persistence` остаётся зелёным.
- [ ] Проведён ручной multi-process smoke: server + отдельный CLI-процесс + Telegram continuity + restart.
- [ ] Создан тег `phase-4.2-http-application-api`.

---

## 4. Границы этапа

### 4.1 Входит

1. Contracts module и рефакторинг SDK на transport port с двумя реализациями (in-process, HTTP).
2. HTTP listener, router, auth middleware, error mapping, request ids, rate/size limits.
3. Static bearer-token authentication для pilot (employee/operator/service planes).
4. Executable standalone CLI поверх HTTP.
5. Перевод Telegram shell на HTTP SDK (loopback, service credential).
6. Composition root Stage 1: один процесс, HTTP + Telegram polling.
7. Специфицированные executable specs для auth/authz/error mapping и multi-transport эквивалентности.
8. Документация: runbook запуска API, env-переменные, threat-model заметки pilot auth.

### 4.2 Не входит

- Методологическая web-панель и любые UI.
- Внешний identity provider, OAuth/OIDC, session cookies, минтинг employee sessions для Telegram (service credential достаточно для Stage 1).
- SSE/WebSocket streaming ответа агента.
- CORS-конфигурация под конкретный web-деплой (появится вместе с web panel).
- Раздельный деплой Telegram worker и API (Stage 2) — только после операционной необходимости.
- Cross-employee/operator чтение insights и любые операторские data endpoints: агрегаты — Phase 6.
- TLS termination внутри Node-процесса: вне loopback — только за reverse proxy.
- Voice/STT (Phase 5), scheduler (Phase 7).
- Изменение database schema: Phase 4.2 не добавляет миграций (кроме случая, если review найдёт блокирующий пробел — тогда отдельным явным решением).

---

## 5. Ключевые архитектурные решения

### 5.1 HTTP без framework: `node:http` + explicit route table

API surface — ~11 операций с JSON-body и простыми path params. По аналогии с решением «`pg` + explicit SQL вместо ORM» берём `node:http` и маленький собственный router:

- ноль новых runtime-зависимостей;
- полный контроль над body limit, timeouts и error mapping;
- route table — явный, ревьюируемый список `(method, pattern, principalRule, schema, handler)`.

Если в ходе реализации ручной разбор станет заметной долей кода (matcher, streaming body, edge cases) — допускается переход на микрофреймворк (Hono) отдельным явным коммитом, не смешивая с бизнес-обвязкой. Express и полные фреймворки не рассматриваются.

### 5.2 Principal model и три identity plane

```ts
type AuthenticatedPrincipal =
  | { kind: "employee"; employeeId: string }
  | { kind: "operator"; operatorId: string }
  | { kind: "service"; serviceId: string };
```

| Plane | Кто | Как выводится employee identity |
|---|---|---|
| `/v1/me/*` | employee principal (standalone CLI сотрудника, позже web) | из token → `principal.employeeId`; body не содержит employeeId |
| `/v1/service/*` | service principal (Telegram shell) | `:employeeId` в path; доверяем, потому что shell уже разрезолвил Telegram identity через приватный `TelegramSessionStore` |
| `/v1/admin/*` | operator principal (админ-CLI) | `employeeId` в body только для явно авторизованных административных операций |
| `/v1/onboarding/*`, `/healthz` | без auth | invite code сам является bearer-секретом; rate limit обязателен |

Handlers пишутся один раз против «trusted scope» (`employeeId`, опционально `threadId`); route-обвязка отличается только тем, откуда scope берётся и какой principal kind допущен. Employee principal, обратившийся к чужому `/v1/service/...` или `/v1/admin/...`, получает `403` без деталей.

### 5.3 Static bearer tokens для pilot

Никакого identity provider на Stage 1. Токены задаются env-переменными, сравниваются timing-safe (`crypto.timingSafeEqual` по digest), не логируются:

```dotenv
# HTTP application API (Phase 4.2)
MINUTKA_API_HOST=127.0.0.1
MINUTKA_API_PORT=8787
# Явное подтверждение non-loopback bind; требует TLS reverse proxy перед процессом.
# MINUTKA_API_ALLOW_NON_LOOPBACK=true

# Pilot static credentials. Generate: openssl rand -hex 32
MINUTKA_SERVICE_TOKEN=            # Telegram shell (kind: service)
MINUTKA_ADMIN_TOKEN=              # operator CLI (kind: operator)
# Dev/pilot employee tokens: employeeId:token pairs, comma-separated.
# MINUTKA_EMPLOYEE_TOKENS=emp_1:tok_aaa,emp_2:tok_bbb

# Standalone CLI process
MINUTKA_API_URL=http://127.0.0.1:8787
MINUTKA_API_TOKEN=
```

Требования:

- fail-fast при старте `serve`, если не задан ни один способ аутентификации, кроме unauthenticated onboarding route;
- токены достаточной entropy (≥32 hex chars); короткие значения отклоняются на config validation;
- loopback-only dev-конфигурация визуально отделена от pilot: non-loopback bind без `MINUTKA_API_ALLOW_NON_LOOPBACK` — startup error;
- этот механизм явно документируется как pilot baseline, не production authentication; замена на настоящий IdP — отдельный этап.

### 5.4 Contracts module — единственный источник DTO

```text
src/contracts/
  minutka-api.ts    # Zod schemas, DTO types, operation names, error codes/envelope
```

- Zod-схемы переезжают из `src/client/sdk/minutka-client.ts` без семантических изменений, кроме удаления `employeeId` из employee-facing request DTOs.
- `MinutkaTransport` типизируется contract-типами (`z.infer`), а не импортами из `application/minutka-service.ts`.
- Server router и SDK используют одни и те же схемы: SDK-валидация — ergonomics, server-валидация — защита границы доверия.
- Error codes фиксируются как contract enum (совпадают с `PersistenceError` codes + transport codes `unauthorized`, `forbidden`, `invalid_request`, `rate_limited`, `internal_error`).

### 5.5 Identity-bound transports

Employee-операции в SDK теряют `employeeId`; привязка identity — ответственность transport:

```ts
// specs / локальная композиция
const employeeClient = new MinutkaClient(
  createInProcessTransport(service, { kind: "employee", employeeId: "emp_1" }),
);

// standalone CLI / Telegram shell
const client = new MinutkaClient(
  new HttpMinutkaTransport({ baseUrl, token }),
);
```

- `InProcessMinutkaTransport` подставляет trusted `employeeId` из principal при вызове `MinutkaService` (сигнатуры `MinutkaService` не меняются — он по-прежнему принимает trusted `employeeId` из scope).
- `HttpMinutkaTransport` для employee-операций зовёт `/v1/me/*`; для service-операций (Telegram shell) — `/v1/service/*` с explicit `employeeId`, полученным из session lookup.
- Service-plane методы (`redeemTelegramInvite`, `recordPrivacyExplanationShown`, employee-scoped chat/consent/onboarding/feedback от имени сотрудника) выделяются в отдельный typed интерфейс (`MinutkaServiceClient` / отдельные методы), чтобы employee CLI физически не имел этих методов.

### 5.6 Маршруты `/v1`

| Операция | Route | Auth |
|---|---|---|
| health | `GET /healthz` | нет |
| issue invite | `POST /v1/admin/invites` | operator |
| open invite | `POST /v1/onboarding/invites/open` | нет; per-IP rate limit |
| redeem Telegram invite | `POST /v1/service/telegram/invites/redeem` | service |
| record privacy explanation shown | `POST /v1/service/employees/:employeeId/privacy-explanation` | service |
| accept consent | `POST /v1/me/consent` · `POST /v1/service/employees/:employeeId/consent` | employee · service |
| complete onboarding | `POST /v1/me/onboarding` · `POST /v1/service/employees/:employeeId/onboarding` | employee · service |
| get profile | `GET /v1/me/profile` · `GET /v1/service/employees/:employeeId/profile` | employee · service |
| chat | `POST /v1/me/threads/:threadId/messages` · `POST /v1/service/employees/:employeeId/threads/:threadId/messages` | employee · service |
| list insights | `GET /v1/me/insights?kind=&threadId=` | employee (scope принудительно = principal) |
| submit feedback | `POST /v1/me/threads/:threadId/feedback` · `POST /v1/service/employees/:employeeId/threads/:threadId/feedback` | employee · service |

Решения по краям:

- **`listInsights` scope-hardening.** Публичный contract больше не допускает чтение без employee scope. Вариант «все insights» остаётся только внутри spec harness (или переносится в test inspection helper); operator data endpoint не создаётся — агрегаты придут в Phase 6 отдельным privacy-projected contour.
- **`openInvite`** возвращает текущий DTO (employeeId + status + privacy explanation): invite code — bearer-секрет, знание кода эквивалентно приглашению. Rate limit и entropy-требование к кодам компенсируют перебор.
- **Thread ownership** проверяется на сервере: `/me/threads/:threadId/*` работает только с thread текущего principal (существующие store contracts уже требуют пару employeeId+threadId, поэтому чужой thread возвращает `message_not_found`/пустой результат, а не данные).

### 5.7 Error mapping

Единый mapper `PersistenceError`/validation → HTTP status:

| Условие / code | Status |
|---|---|
| malformed JSON, schema validation, unknown fields → `invalid_request` | 400 |
| нет/невалидный token → `unauthorized` | 401 |
| principal есть, plane/scope запрещён → `forbidden` | 403 |
| `invite_not_found`, `participant_not_found`, `profile_not_found`, `message_not_found` | 404 |
| `invite_conflict`, `employee_already_linked`, `chat_already_linked`, `persistence_conflict` | 409 |
| `consent_required` | 409 (с кодом в envelope) |
| rate limit → `rate_limited` | 429 |
| body size limit | 413 |
| `persistence_unavailable`, всё неожиданное → `internal_error` | 503 / 500 |

`message` в envelope — короткая безопасная фраза; подробности — только в redacted server log с `requestId`. Server присваивает `req_<uuid>` каждому HTTP-запросу, возвращает его в envelope и header `x-request-id`. Проброс HTTP request id внутрь `MinutkaService` audit не входит в scope (service генерирует собственный requestId); корреляция по времени/employee достаточна для pilot, объединение id — возможное будущее улучшение.

### 5.8 Composition Stage 1

```text
src/runtime/
  serve.ts            # main: env → createPostgresRuntime → HTTP listener → optional Telegram
src/server/http/
  http-server.ts      # node:http listener factory (host/port/timeouts/limits)
  router.ts           # route table + dispatch
  auth.ts             # token parsing → AuthenticatedPrincipal
  error-mapping.ts
  rate-limit.ts
  in-process-server.ts  # остаётся transport adapter для specs (переименован/задокументирован)
src/client/cli/
  main.ts             # executable: MINUTKA_API_URL/TOKEN → HttpMinutkaTransport → runMinutkaCli
src/client/sdk/
  minutka-client.ts   # facade над contracts
  http-transport.ts   # HttpMinutkaTransport
  in-process-transport.ts
```

`package.json`:

```json
{
  "scripts": {
    "serve": "tsx src/runtime/serve.ts",
    "telegram:dev": "TELEGRAM_MODE=polling tsx src/runtime/serve.ts",
    "cli": "tsx src/client/cli/main.ts"
  }
}
```

- `TELEGRAM_MODE` — `disabled` (default) | `polling`; `polling` без `TELEGRAM_BOT_TOKEN` — startup error. Автоматического «включён, если токен есть» не допускается: конфигурация явная.
- Telegram shell внутри `serve` получает `MinutkaClient` с `HttpMinutkaTransport` на `http://127.0.0.1:<port>` и `MINUTKA_SERVICE_TOKEN` — production authorization path, как требует RFC.
- Startup order: env validation → pool + migration check → HTTP listen → invite seeds (через client) → Telegram launch. Любая ошибка до `listen` — process exit ≠ 0.
- Shutdown order: `server.close()` (stop accept) → Telegram `stop` + drain `launchCompleted` → drain in-flight HTTP → `pool.end()`.
- `src/telegram/main.ts` заменяется на thin alias/удаляется в пользу `serve.ts` (сохранив поведение `telegram:dev`).

---

## 6. Security baseline

1. **Валидация на границе.** Все body/params/query парсятся contract-схемами до вызова use case; malformed/unauthenticated запрос не достигает `MinutkaService` (проверяется spec-ом со счётчиком вызовов scripted service).
2. **Timing-safe token compare.** Сравнение через digest + `timingSafeEqual`; отсутствие раннего выхода по длине.
3. **Rate limits.** In-memory token bucket: per-IP на `POST /v1/onboarding/invites/open` (например 10/мин) и общий per-principal лимит на mutable operations (например 60/мин). Значения — code constants, покрытые tests; distributed limiter не нужен для одного процесса.
4. **Size/time limits.** JSON body ≤ 64 KiB (413), `server.headersTimeout`/`requestTimeout` заданы; handler-таймаут chat ≥ LLM budget (60–120 s), остальные — короткие.
5. **Redacted logging.** Access log: method, path template (не raw path с чужими ids), status, duration, requestId, principal kind. Не логируются: tokens, invite codes, chat text, Telegram IDs, SQL/provider errors.
6. **Loopback default.** `127.0.0.1` по умолчанию; non-loopback требует explicit env + документированный reverse proxy с TLS. Незащищённый non-loopback dev-сервер не поддерживается.
7. **Никаких новых копий personal data.** HTTP-слой stateless: не кэширует ответы, не пишет собственных таблиц.

---

## 7. Testing strategy

### 7.1 Существующие executable specs

- Spec harness переходит на principal-bound `InProcessMinutkaTransport`: employee-клиент создаётся per employee, admin-операции — через operator-обвязку harness.
- CLI-driver specs обновляются под новую grammar (`employee` без `--employee`, `admin issue-invite --employee ...`).
- Telegram driver продолжает работать: shell получает client, как раньше; для specs — in-process transport с service principal.

### 7.2 `SPEC-HTTP-API-001`

```text
specs/executable/http-api/SPEC-HTTP-API-001.spec.ts
```

Реальный `node:http` listener на `127.0.0.1:0` (ephemeral port) поверх in-memory runtime + scripted agent/router. Сценарии:

1. Запрос без token к `/v1/me/*` → 401, envelope с `unauthorized` и `requestId`; `MinutkaService` не вызван.
2. Employee token A запрашивает данные, полученный ответ содержит только данные A; попытка B прочитать thread/feedback/insights A через параметры → 403/404 без утечки существования.
3. Employee token не может вызвать `/v1/admin/*` и `/v1/service/*` → 403.
4. Body с лишним полем `employeeId` на `/v1/me/*` → 400 (strict schema).
5. Malformed JSON → 400; oversized body → 413.
6. `PersistenceError` codes мапятся на задокументированные statuses (matrix test).
7. `invite open` rate limit: N+1-й запрос с одного IP → 429.
8. Ответы об ошибках не содержат stack, SQL, invite code, Telegram id (regex-контроль serialized response).
9. Health endpoint отвечает без auth и без database metadata.
10. Unknown route/method → 404/405 c envelope.

### 7.3 `SPEC-CLI-HTTP-001`

```text
specs/executable/http-api/SPEC-CLI-HTTP-001.spec.ts
```

1. Поднять listener (in-memory runtime, ephemeral port).
2. Собрать `MinutkaClient` + `HttpMinutkaTransport` с employee token и прогнать `runMinutkaCli`: onboarding → chat → profile → insights → feedback.
3. Проверить эквивалентность: тот же сценарий через in-process transport даёт те же validated DTO (multi-transport parity).
4. Admin CLI issue-invite с operator token; с employee token → exit code 1 и safe message.

Отдельный OS-процесс в hermetic specs не форкается — process boundary доказывается реальным TCP listener + manual smoke (7.5); опционально в `specs/persistence` добавляется один integration test со спавном `npm run cli` против запущенного сервера, если это не сделает suite хрупким.

### 7.4 Guard-тесты слоёв

- Import-boundary test: `src/contracts/**` и `src/client/sdk/**` не импортируют `server/http`, `application/minutka-service`, `pg`, `telegraf` (проверка через анализ import statements в spec).
- `MinutkaService` файл не содержит импортов `node:http`/auth-модулей.

### 7.5 Manual smoke (multi-process)

1. PostgreSQL up, `npm run db:migrate`.
2. `.env`: DATABASE_URL, peppers, `MINUTKA_SERVICE_TOKEN`, `MINUTKA_ADMIN_TOKEN`, employee token, Telegram/OpenAI credentials, `TELEGRAM_MODE=polling`.
3. `npm run serve` — process A.
4. Терминал B: `npm run cli -- admin issue-invite --employee emp_pilot --invite <code>` (operator token).
5. Терминал B: открыть invite, принять consent, пройти onboarding, `employee chat`, `employee profile` — с employee token, без `--employee`.
6. Telegram: тот же сотрудник (redeem через бот для второго тестового employee) — убедиться, что оба канала видят один runtime state.
7. Отправить chat через CLI, затем спросить в Telegram — continuity контекста в пределах общего thread модели.
8. Рестарт process A: CLI и Telegram продолжают видеть state; повторный `/start` узнаёт binding.
9. Негатив: чужой token → 403/404; неверный token → 401; запрос на `/v1/admin/*` с employee token → 403.
10. Проверить логи: нет tokens, invite codes, raw text, Telegram IDs.

---

## 8. Implementation sequence

Каждый шаг заканчивается зелёным targeted typecheck/specs; крупные шаги — отдельные commits.

### Step 0 — baseline и prerequisite lock

1. Prerequisite выполнен: Phase 4.1 закрыта (`verify:persistence` зелёный, ручной Telegram restart smoke успешен, тег `phase-4.1-durable-runtime-foundation` создан).
2. `npm run verify`, `nix run .#verify` зелёные; зафиксировать spec results.
3. Записать decision log этапа: node:http без framework, static bearer tokens, Stage 1 один процесс, insights scope-hardening, никакой web-панели.

**Проверка:** baseline green, чистый diff.

### Step 1 — contracts module

1. Создать `src/contracts/minutka-api.ts`; перенести Zod-схемы из SDK.
2. Удалить `employeeId` из employee-facing request schemas; добавить service-plane schemas с explicit `employeeId`.
3. Добавить error envelope schema и contract error codes.
4. Типизировать `MinutkaTransport` contract-типами.

**Проверка:** typecheck; SDK компилируется против contracts.

### Step 2 — identity-bound transports и SDK refactor

1. `InProcessMinutkaTransport(service, principal)`: подстановка trusted `employeeId`, разграничение employee/service/operator методов.
2. `MinutkaClient` разделить на employee surface и service/admin surface (отдельные фасады или методы-группы).
3. Обновить spec harness/fixtures на principal-bound клиентов; `createInProcessServer` — deprecated alias до конца шага, затем удалить.

**Проверка:** все существующие executable specs зелёные.

### Step 3 — CLI grammar

1. Employee-команды без `--employee`; `admin` group с `--employee`.
2. Обновить cli-driver specs.
3. `listInsights` CLI — только собственный scope (`--thread`, `--kind`).

**Проверка:** CLI specs зелёные.

### Step 4 — HTTP server foundation

1. `postgres`-независимые модули: config parsing/validation (host/port/tokens/limits), `auth.ts`, `error-mapping.ts`, `rate-limit.ts`.
2. `http-server.ts` + `router.ts`: dispatch, JSON body с limit, request id, access log, `/healthz`, 404/405.
3. Unit-level tests через listener на ephemeral port.

**Проверка:** новые модульные tests; typecheck.

### Step 5 — routes поверх `MinutkaService`

1. Route table `/v1/*` из §5.6 с server-side schema validation и principal rules.
2. Error mapping `PersistenceError` → statuses.
3. `SPEC-HTTP-API-001` red → green по сценариям.

**Проверка:** `SPEC-HTTP-API-001`.

### Step 6 — `HttpMinutkaTransport` и executable CLI

1. Fetch-based transport: bearer header, timeout, error envelope → typed client error.
2. `src/client/cli/main.ts` + `npm run cli`.
3. `SPEC-CLI-HTTP-001` (listener + CLI через HTTP + parity с in-process).

**Проверка:** `SPEC-CLI-HTTP-001`.

### Step 7 — composition root `serve` и Telegram over HTTP

1. `src/runtime/serve.ts`: env → postgres runtime → HTTP listen → invite seeds → optional Telegram polling; startup/shutdown ordering из §5.8.
2. Telegram shell получает client с `HttpMinutkaTransport` (loopback, service token); session store остаётся direct.
3. Удалить/заалиасить `src/telegram/main.ts`; обновить scripts.

**Проверка:** запуск/остановка runtime со scripted Telegram adapter; existing Telegram specs.

### Step 8 — guard-тесты и негативы

1. Import-boundary tests (§7.4).
2. Rate limit, size limit, forbidden-fields-in-response assertions.
3. Прогон `verify:persistence` (контракты stores не менялись — suite должен пройти без правок).

**Проверка:** полный `npm run verify` + `verify:persistence`.

### Step 9 — docs

Обновить:

- `docs/plans/time-agent-mastra-plan.md` (статус Phase 4.2);
- `docs/architecture/rfc-http-application-api.md` → status: implemented + implementation notes;
- `.env.example` (§5.3);
- `docs/runbooks/postgres-runtime.md` или новый `docs/runbooks/http-api-runtime.md`: запуск serve, CLI, tokens, smoke;
- privacy notes: что появилось на network boundary и какие данные никогда не возвращаются.

**Проверка:** команды из runbook выполнены руками.

### Step 10 — final smoke и tag

1. `npm run verify`, `nix run .#verify`, `npm run verify:persistence`.
2. Manual multi-process smoke (§7.5).
3. Review diff: нет секретов, `.env`, dumps.
4. Логические commits, тег `phase-4.2-http-application-api`.

---

## 9. Recommended commit structure

1. `refactor(contracts): extract transport-neutral minutka api contracts`
2. `refactor(sdk): bind identity in transports and split employee surface`
3. `refactor(cli): derive employee identity from credentials`
4. `feat(server): add http listener auth and error mapping foundation`
5. `feat(server): expose v1 application routes over minutka service`
6. `feat(sdk): add http transport and standalone cli entrypoint`
7. `feat(runtime): serve http api and telegram from one composition root`
8. `test(http): add authz negative and multi-transport parity coverage`
9. `docs: document http api runtime and pilot auth baseline`

---

## 10. Risks и mitigation

| Риск | Mitigation |
|---|---|
| Ручной node:http router накопит edge-case баги | Explicit route table, body/limit helpers с unit tests, разрешённый fallback на Hono отдельным коммитом. |
| Удаление `employeeId` из DTO сломает existing specs широким фронтом | Steps 1–3 идут до HTTP: principal-bound in-process transport сохраняет поведение, specs чинятся до появления сети. |
| Static tokens протекут в логи/копипасту | Токены не логируются; access log печатает только principal kind; runbook требует `openssl rand -hex 32` и отдельные значения по средам. |
| Telegram через loopback HTTP добавит latency/hop-failures | Loopback overhead незначим против LLM latency; HTTP errors мапятся в те же typed codes, shell поведение не меняется; fail-fast при недоступном listener на старте. |
| `MinutkaService` начнёт обрастать HTTP-знанием | Guard-тест импортов + review; principal остаётся в router, сервис получает только trusted scope. |
| Rate limiter в памяти обнулится при рестарте | Приемлемо для Stage 1 (один процесс, loopback); фиксируется как известное ограничение pilot. |
| Chat request упрётся в HTTP timeout при медленном LLM | Отдельный handler-таймаут для chat ≥ LLM budget; таймауты — именованные константы с tests. |
| Незаметный запуск API на внешнем интерфейсе без TLS | Loopback default + explicit `MINUTKA_API_ALLOW_NON_LOOPBACK` + startup warning/refusal. |
| Scope creep в web UI/streaming/OAuth | Явные non-goals §4.2; web-панель и streaming — отдельные этапы. |
| `openInvite` станет oracle для перебора кодов | Rate limit per IP, entropy-требование к invite codes, 404 без различения «нет кода» / «код чужой». |

---

## 11. Acceptance criteria

Phase 4.2 завершена, только если доказуемо следующее:

1. **Process boundary:** `npm run serve` поднимает HTTP listener; `npm run cli` из другого OS-процесса выполняет onboarding/chat/profile/feedback и видит то же состояние; CLI никогда не создаёт `InMemoryWorld`.
2. **Shared runtime:** Telegram и CLI используют один HTTP SDK contract и один PostgreSQL state; continuity подтверждена manual smoke.
3. **Identity из principal:** все публичные employee-операции выводят `employeeId` из authenticated context; caller-supplied employee id на `/me/*` отклоняется strict-схемой.
4. **Authorization:** cross-employee и cross-plane попытки (employee → admin/service, employee B → данные A) отклоняются 403/404 без утечки данных; malformed/unauthenticated запрос не достигает `MinutkaService`.
5. **Clean layers:** `MinutkaService` без HTTP/auth/framework зависимостей; `client/sdk` не импортирует из `server/http`; contracts module transport-neutral.
6. **Validated errors:** API возвращает versioned error envelope с `requestId`; никаких stack traces, SQL/provider payloads, invite codes, Telegram IDs, raw prompt material в ответах и access logs.
7. **Hermetic verification:** `npm run verify` и `nix run .#verify` зелёные без PostgreSQL/сети; `SPEC-HTTP-API-001` и `SPEC-CLI-HTTP-001` работают на ephemeral-port listener с in-memory runtime.
8. **Persistence intact:** `npm run verify:persistence` зелёный; restart-поведение Phase 4.1 не деградировало (manual smoke шаг 8).

---

## 12. Следующие этапы после Phase 4.2

- **Phase 5 — Voice/STT:** voice handler в Telegram shell поверх того же HTTP/application path.
- **Phase 6 — Automation map:** отдельный анонимизированный aggregation contour; операторские data endpoints появляются только там, с privacy projection ≥5 сотрудников.
- **Web panel / настоящий auth:** отдельный этап — identity provider, sessions, CORS, streaming; contract `/v1` расширяется additively.
- **Stage 2 deployment:** раздельный деплой Telegram worker и API без изменения contract — только при операционной необходимости.
