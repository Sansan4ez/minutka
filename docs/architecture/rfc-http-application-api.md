# RFC: HTTP application API and transport-neutral SDK

## Status

**Implemented (Phase 4.2).** This RFC introduces an authenticated HTTP transport in front of
`MinutkaService` so that a standalone CLI, the Telegram shell, and a future web
panel can use the same long-lived application runtime and persistent data.

Related documents:

- [Master Mastra plan](../plans/time-agent-mastra-plan.md)
- [Phase 4: Telegram text and feedback](../plans/phase-4-telegram-text-feedback.md)
- [Agent Vault architecture](./agent-vault.md)
- [Runtime projections RFC](./rfc-runtime-projections.md)
- [Data Storage and Privacy Layer](../diagram_modules/product-parts/data-storage-and-privacy-layer.md)

## Context and problem

The current layering is intentionally transport-agnostic in principle:

```text
Domain → Application → Server → SDK → CLI / Telegram
```

In the implementation, however, `src/server/http/in-process-server.ts` is not
an HTTP server. It creates a JavaScript object around `MinutkaService`, and
`MinutkaClient` receives that object directly. This is useful for executable
specs because all dependencies run in one Node.js process.

It cannot meet the following operational requirement:

```text
$ minutka employee profile --employee emp_1
```

must be runnable from a separate terminal and observe the same user, profile,
conversation, feedback, and insight state as the already-running Telegram
runtime. A second terminal cannot reference an object held in the bot process;
it either needs a process boundary transport or it creates an unrelated
in-memory world.

A browser-based operator panel has the same requirement. Browsers require a
network-facing transport, and they must never receive direct database or
`MinutkaService` access.

## Decision summary

Introduce a real, versioned HTTP application API, with the first deployment
allowed to remain one Node.js process:

```text
Telegram polling shell ─┐
Standalone CLI ─────────┼── HTTPS / HTTP loopback ── Application API
Web panel ──────────────┘                              │
                                                        ▼
                                                 MinutkaService
                                                        │
                                                        ▼
                                      persistent application stores
```

The initial deployment may host the Telegram polling adapter and the HTTP
listener in the same Node.js process. This is a deployment decision, not an
in-process client integration: the standalone CLI and the web panel always call
the HTTP API. Telegram should also use the same HTTP SDK once the API is
introduced, so it exercises the production authorization and serialization
path.

The existing in-process adapter remains only for executable specs and narrowly
scoped local composition tests.

## Goals

1. Make the CLI a separately executable process that talks to a running service.
2. Make Telegram, CLI, and a future web panel share application use cases and
   persistent state rather than duplicate business rules.
3. Keep `MinutkaService` independent from HTTP, Commander, Telegraf, browser
   concerns, and authentication protocol details.
4. Preserve runtime input/output validation and typed TypeScript SDK ergonomics.
5. Enforce identity and role authorization before application storage is read.
6. Provide an incremental path from a loopback/local environment to a pilot
   deployment without changing application use cases or client method names.
7. Keep raw transcripts, provider payloads, Telegram IDs, invite secrets, and
   cross-employee data out of inappropriate API responses.

## Non-goals

- Implementing the methodologist web UI itself.
- Selecting a final identity provider, KMS, encryption scheme, retention policy,
  or production hosting platform.
- Exposing generic CRUD access to every store or database table.
- Turning `/proc`, `/bin`, or `/run` into unrestricted remote filesystem paths.
- Making all existing development/test endpoints public without authorization.
- Separating Telegram, HTTP API, and web UI into independently deployed
  services on day one.
- Replacing Mastra with HTTP or exposing Mastra internals as the public API.

## Why the prior all-in-process option is insufficient

One process can contain Telegram polling, an HTTP listener, and a local web
asset server. That is useful because it keeps deployment simple. It does **not**
make an in-process SDK accessible from an independently launched CLI.

A separate CLI process needs one of HTTP, Unix-domain sockets, named pipes, or
an RPC protocol. The future web panel needs HTTP/WebSocket or a comparable
browser-compatible transport. Since both a browser and cross-machine pilot
deployment are planned, HTTP is the shared transport with the lowest additional
surface. A Unix socket/RPC-only solution would still require another browser
transport later.

## Existing plan alignment

The master plan anticipates an HTTP server as one of the external entry points:

> client CLI, Telegram bot, and HTTP server call shared typed application
> interfaces.

It describes `server/http` as an API surface that starts in-process and can
later replace its transport. It does not schedule a concrete implementation
phase for a network HTTP server.

Phase 4 explicitly chose the opposite scope boundary for the Telegram MVP:

> Do not add an HTTP server if the in-process server is sufficient.

Phase 4.2 implements this boundary after the durable PostgreSQL foundation. The
listener and HTTP transport are now the shared runtime path for standalone CLI
and optional Telegram polling; the in-process transport remains spec-only.

## Architecture

### Composition and ownership

```text
                         ┌─────────────────────────────┐
Telegram update ────────▶│ Telegram shell               │
                         │ HttpMinutkaClient            │
Standalone CLI ─────────▶│ HttpMinutkaClient            │
                         └─────────────┬───────────────┘
                                       │
                                       ▼
                         ┌─────────────────────────────┐
                         │ HTTP router / auth middleware │
                         │ request parsing / response    │
                         │ mapping / error mapping       │
                         └─────────────┬───────────────┘
                                       │ trusted principal + scope
                                       ▼
                         ┌─────────────────────────────┐
                         │ MinutkaService               │
                         │ application use cases        │
                         └─────────────┬───────────────┘
                                       │
             ┌─────────────────────────┼─────────────────────────┐
             ▼                         ▼                         ▼
       Profile/consent            message/insight/          session and
       participant store          feedback stores            audit stores
```

The HTTP router owns transport concerns only:

- parsing path, headers, and JSON body;
- authentication and authorization;
- deriving a trusted actor and access scope;
- mapping stable request/response DTOs to application use cases;
- mapping expected application errors to safe status codes;
- adding request IDs, timeouts, rate limits, and redacted observability.

`MinutkaService` keeps use-case ownership. It does not inspect HTTP headers,
validate bearer tokens, know a Telegram chat ID, or emit HTTP responses.

### Deployment stages

**Stage 1: one process, real HTTP boundary.** One command starts an HTTP listener
and Telegram polling. The CLI reaches `http://127.0.0.1:<port>` and the web UI
uses the same API. Persistent storage is shared by the process and survives
restart.

**Stage 2: independently deployed adapters.** Telegram worker, API/web server,
and web UI can be separated without changing the API contract. All connect to
the same persistent stores through the application API.

Stage 1 is the recommended first implementation. It gives the required
separate-terminal CLI and browser-compatible API without prematurely adding
microservices.

## API contract

### Versioning and format

The API is JSON over HTTPS and is namespaced under `/v1`. Responses use JSON;
errors use a stable envelope:

```json
{
  "error": {
    "code": "profile_not_found",
    "message": "Profile is not available for this account.",
    "requestId": "req_..."
  }
}
```

The server does not return stack traces, store errors, provider errors, raw
prompt material, invite codes, or internal transport identifiers. Additive
fields are permitted in a minor-compatible change; removals and semantic changes
require `/v2` or an agreed migration period.

The exact route names can evolve during implementation, but the initial typed
operations should cover the existing SDK surface:

| Operation | Initial route | Caller identity rule |
|---|---|---|
| issue invite | `POST /v1/admin/invites` | admin/operator only |
| open invite | `POST /v1/onboarding/invites/open` | unauthenticated invite flow, rate-limited; returns no unnecessary participant data |
| accept consent | `POST /v1/me/consent` | current employee only |
| complete onboarding | `POST /v1/me/onboarding` | current employee only |
| get own profile | `GET /v1/me/profile` | current employee only |
| chat | `POST /v1/me/threads/:threadId/messages` | current employee owns the thread |
| list own insights | `GET /v1/me/insights` | current employee only, bounded filters |
| submit feedback | `POST /v1/me/threads/:threadId/feedback` | current employee owns thread and target message |

A future methodologist panel receives distinct `/v1/admin/*` or
`/v1/operator/*` operations. It must return only approved operational status and
safe aggregates; it must not reuse employee detail endpoints with a different
filter.

### Identity and authorization

The current method signatures often accept `employeeId` because they were built
for specs and in-process CLI usage. This is unsafe as a public client contract:
a browser or arbitrary CLI must not select another employee simply by changing a
JSON field.

The API introduces a transport-independent principal:

```ts
type AuthenticatedPrincipal =
  | { kind: "employee"; employeeId: string }
  | { kind: "operator"; operatorId: string; permissions: string[] }
  | { kind: "service"; serviceId: string; permissions: string[] };
```

The HTTP authentication layer creates it from a session/token or trusted service
credential. The route derives `employeeId` from the principal for `/me/*` calls.
The body does not contain an employee identifier for those routes. Thread
ownership, invite claim, and Telegram identity mapping are checked server-side.

For local development, a loopback-only development credential may be provided.
It must be visibly separate from pilot configuration and must not silently
become production authentication.

A standalone admin CLI authenticates as an operator/service account and may
name the employee only for explicitly authorized administrative operations.
Employee CLI commands authenticate as that employee and use `/me/*` operations.

### Telegram adapter

Telegram remains a shell, not an authority. It maps Telegram identity through a
persistent session/identity boundary and then calls the HTTP SDK with its
service credential or a minted employee session. The mapping remains outside
insights, feedback records, company analytics, and general domain events.

Invite redemption must be atomic: one invite is bound to the first permitted
identity, and a replay from another Telegram identity is rejected. This is a
precondition for exposing the API to multiple clients.

## SDK transformation

### Current state

`MinutkaClient` currently combines two roles:

1. it owns Zod request/response validation; and
2. it directly invokes `MinutkaApi`, an object produced by the so-called
   in-process server.

It imports that API type from `server/http/in-process-server`, which reverses
the desired dependency direction for a reusable client.

### Target state

Keep the **public SDK method names and Zod validation**, but make the underlying
transport replaceable.

```text
CLI / Telegram / web backend
       ↓
MinutkaClient (validation + typed public methods)
       ↓
MinutkaTransport (transport port)
       ├─ HttpMinutkaTransport       production and standalone CLI
       └─ InProcessMinutkaTransport  specs and local composition tests
```

Introduce a transport-neutral contracts module, for example:

```text
src/contracts/minutka-api.ts
```

It owns stable request/response DTO types, route-operation names, and shared
Zod schemas. It does not import HTTP frameworks, Telegraf, Commander,
`InMemoryWorld`, or `MinutkaService`.

`MinutkaClient` becomes a validated facade over a structural transport port:

```ts
export type MinutkaTransport = {
  chat(input: ChatRequest): Promise<ChatResponse>;
  issueInvite(input: IssueInviteRequest): Promise<IssueInviteResponse>;
  // remaining existing operations
};

export class MinutkaClient {
  constructor(private readonly transport: MinutkaTransport) {}

  async chat(input: unknown): Promise<ChatResponse> {
    return chatResponseSchema.parse(
      await this.transport.chat(chatRequestSchema.parse(input)),
    );
  }
}
```

The implementation names are illustrative. The compatibility requirement is
that existing caller code remains conceptually unchanged:

```ts
const client = new MinutkaClient(new HttpMinutkaTransport({ baseUrl, auth }));
await client.chat({ threadId, text });
```

For executable specs:

```ts
const client = new MinutkaClient(createInProcessTransport(service));
```

The in-process adapter may initially retain `createInProcessServer` as a
compatibility alias, but it is renamed/documented as a transport adapter, not
an HTTP server. `client/sdk` must no longer import a type from `server/http`.

### CLI transformation

The CLI command grammar stays the presentation layer:

```bash
minutka employee chat --thread workday-1 --text "..."
```

A new executable entrypoint constructs `HttpMinutkaTransport` from:

```text
MINUTKA_API_URL=https://localhost:8787
MINUTKA_API_TOKEN=...
```

and calls the existing `runMinutkaCli(client, argv)`. Commander parsing and JSON
output behavior remain testable independently. The CLI does not construct
`InMemoryWorld`, `MinutkaService`, a Telegram shell, or Mastra agents.

For employee-facing commands, the token determines employee identity; the CLI
must not require or trust `--employee`. A separate, clearly privileged admin
command group may accept `--employee` where the endpoint authorizes it.

### Server transformation

The current object adapter is retained as:

```text
MinutkaService → InProcessMinutkaTransport
```

The HTTP router is a different adapter:

```text
HTTP request → authenticated principal → MinutkaService → HTTP response
```

Both use the same contract schemas. The router must validate at its trust
boundary even if the SDK also validates: SDK validation improves caller
ergonomics; server validation protects the service from arbitrary clients.

## Persistent storage prerequisite

An HTTP listener by itself does not create shared durable state. Before the API
is used by a standalone CLI, Telegram, or web UI as a live multi-user runtime,
implement persistent adapters for:

- participants, invite claims, consent, and profiles;
- messages/conversation lookup;
- insights and feedback;
- Telegram identity/session mapping;
- approved audit/event records;
- the selected canonical conversation-memory implementation.

For local staging, a file-backed SQLite/libSQL implementation can be sufficient.
For a multi-user pilot, choose and document a database, migrations, backups,
access controls, and privacy lifecycle; PostgreSQL is the likely default. The
Mastra `LibSQLStore` currently configured with `:memory:` is neither a shared
application store nor durable message history for the direct Telegram runtime.

## Error handling and operational behavior

- Validate body/query/params with the shared schemas at the server boundary.
- Return `400` for malformed requests, `401` for missing/invalid identity,
  `403` for an authenticated but unauthorized principal, `404` where a
  non-sensitive not-found response is safe, `409` for invite/idempotency
  conflicts, `429` for rate limits, and `5xx` only for unexpected failures.
- Apply a request ID and redact logs. Do not log raw chat text by default.
- Apply request size limits, per-principal rate limits, LLM timeout/cancellation,
  and safe idempotency rules for mutable callback-like operations.
- Use HTTPS outside loopback development. Do not expose a non-loopback,
  unauthenticated development server.
- Keep streaming optional for the first version. A normal `POST` chat response
  is enough to make the CLI functional. Add SSE/WebSocket only when a web UI
  needs token streaming, using a separate documented contract.

## Implementation outline

1. **Resolve prerequisites and contract.** Select the HTTP framework consistent
   with the repository, define API versioning, auth approach for local/staging,
   and shared contract schemas. Decide the persistent database and migration
   mechanism before calling the API pilot-ready.
2. **Extract transport-neutral contracts.** Move SDK Zod schemas/types out of
   the current server-dependent client module; define `MinutkaTransport`.
   Preserve current in-process behavior through an adapter.
3. **Implement persistent adapters.** Implement and test durable stores,
   including atomic invite claim and Telegram identity binding. Wire one
   composition root that owns stores and `MinutkaService`.
4. **Implement HTTP router.** Add authenticated routes around existing use
   cases, server-side schema validation, principal-to-scope derivation, error
   mapping, request IDs, and safe logs.
5. **Implement HTTP SDK transport and executable CLI.** Add
   `HttpMinutkaTransport`, a `MINUTKA_API_URL`-configured CLI entrypoint, and
   preserve `runMinutkaCli()` command parsing.
6. **Move Telegram to the HTTP SDK.** Configure Telegram with a service
   credential/identity flow and remove its direct dependency on in-process
   application construction.
7. **Add web-facing foundation only.** Serve a health endpoint and CORS/auth
   configuration appropriate to the selected web deployment. Do not build the
   methodologist UI in this RFC.
8. **Optional separation.** Only after Stage 1 works, deploy Telegram worker and
   API separately if operational evidence requires it.

## Testing approach

### Unit and contract tests

- Every public request/response schema accepts valid inputs and rejects invalid
  or unknown fields.
- `MinutkaClient` yields the same validated result through in-process and HTTP
  transports.
- HTTP handlers map authenticated identity to application scope and ignore
  employee IDs supplied by an employee client.
- An employee cannot read/write another employee's profile, thread, insight, or
  feedback by changing a path/body parameter.
- An operator endpoint cannot return raw personal conversations, tasks,
  profiles, or individual emotional states.
- Invite redemption is atomic; a second Telegram identity cannot claim an
  existing employee's invite.

### Integration tests

- Start a real HTTP listener with test storage; run the standalone CLI in a
  separate process and prove that its onboarding/chat/profile operations are
  visible to the server process.
- Telegram shell and standalone CLI use the same server and observe the same
  allowed profile/thread state.
- Restart the server and prove approved persistent records and session mapping
  survive.
- A malformed/unauthenticated request never reaches `MinutkaService`.
- LLM/Telegram calls remain mocked in normal specs; a separate manual smoke
  validates real provider and Telegram credentials.

### Manual smoke

1. Start API + Telegram composition root with a local persistent database.
2. Run the standalone CLI from another terminal against `MINUTKA_API_URL`.
3. Create/claim an authorized test user, complete onboarding, and retrieve the
   profile through the CLI.
4. Send a Telegram message for the same identity and verify continuity.
5. Restart the server and verify that authorized state persists.
6. Attempt another identity's invite/profile/thread and verify rejection.

## Acceptance criteria

The RFC is implemented when:

- `npm run` exposes a command that starts an HTTP application listener and a
  separate `minutka` CLI command that targets `MINUTKA_API_URL`.
- The CLI runs in a different OS process and shares the running service state;
  it never creates its own `InMemoryWorld`.
- Telegram and CLI use the same HTTP SDK contract in the runtime composition.
- `MinutkaService` has no HTTP/framework/authentication dependency.
- `MinutkaClient` retains schema validation and works with an HTTP transport;
  in-process transport remains available for specs.
- Client SDK code does not import API types from `server/http`.
- All public employee operations derive employee identity from authenticated
  context, not a caller-controlled `employeeId`.
- Persistent stores preserve approved profile, consent, message, feedback,
  insight, and session state across restart.
- Invite claim/replay and cross-employee access tests pass.
- The API returns redacted, versioned errors and never returns raw internal
  events, secrets, provider payloads, or unauthorized personal data.

## Alternatives considered

### Keep only in-process clients

Rejected for the stated requirement: a separately launched CLI cannot access
another process's objects. A browser cannot use this boundary either.

### Unix socket or JSONL RPC only

Useful for a local admin tool, but does not serve a browser and would create an
additional transport when the web panel arrives. It is not the primary API.

### Let CLI read/write the database directly

Rejected. It bypasses use cases, authorization, audit, validation, rate limits,
and the privacy boundary. It would also make the CLI database-vendor-specific.

### Put business logic in Telegram and duplicate it in the web panel

Rejected. Onboarding, consent, invite policy, feedback validation, and privacy
rules would drift by channel.

### Expose Mastra's server/API as the product API

Rejected. Mastra is an infrastructure runtime. The product API must expose
Minutka use cases and privacy-safe DTOs, not generic agent, storage, or prompt
operations.
