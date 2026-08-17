# RFC: runtime projections for the Agent Vault

## Status

**Historical foundation: implemented in Phase 4.1; the agent-led projections supersede the legacy agent path.** This RFC specifies the original implementation of the dynamic parts of Minutka's logical Agent Vault namespace: `/proc`, `/run`, and the boundary with other namespace families. The current «Минутка» clone reuses owner-scoped projections assembled by `AssistantService`; legacy `minutkaAgent` was removed in A2.6. The document remains as provenance and does not introduce a real filesystem. Live product boundaries are in [RFC «Минутки»](./rfc-minutka-tenancy-and-reporting.md).

Related documents:

- [Agent Vault architecture](./agent-vault.md)
- [`vault/proc/README.md`](../../vault/proc/README.md)
- [`vault/run/README.md`](../../vault/run/README.md)
- [Phase 3.5 plan](./minutka-foundation.md)
- [Unix dependency-model research](../../researches/report-instruction-version-store-unix-dependency-model.md)

## Context and problem

The vault presents a stable, Unix-like logical namespace to the agent:

```text
/AGENTS.md  root instructions
/processes  selectable business processes
/docs       active runtime-facing documentation
/proc       current, sanitized application state
/bin        allowed typed operations
/run        audit and action traces
```

Only the static families are Git files under `vault/`. The values represented by
`/proc` and `/run` originate in application storage and runtime events. They
must not be copied into `vault/proc` or `vault/run` as employee data.

The current implementation has **contracts but not a virtual filesystem**:

- `vault/proc/README.md`, schemas, and `vault/run/README.md` define the intended
  handles;
- `MinutkaService` reads application stores directly;
- `MinutkaContextBuilder` renders instructions and profile context into
  `systemContext`;
- recent turns are supplied to the agent runner as an in-process object;
- `world.events` is an in-memory event list in the prototype.

There is currently no `read("/proc/profile")` operation, no mounted directory,
no symlink, and no temporary JSON file that contains employee state. This RFC
turns the namespace into an explicit, testable application boundary without
requiring OS-level filesystem machinery.

## Goals

1. Define a stable read contract for `/proc/*` and `/run/*` independent of the
   physical database and of the LLM provider.
2. Give the agent only the minimum state needed for the active employee and
   thread; do not give it database credentials, arbitrary SQL, or unrestricted
   record lookup.
3. Keep personal state out of Git, temporary files, logs, and prompt traces
   unless the data is explicitly required for the current answer.
4. Make prompt assembly, later tool-based reads, and remote endpoints use the
   same projection logic and schemas.
5. Preserve application ownership: stores and use cases remain the source of
   truth; vault projections are read models.
6. Make the target incremental: it works first with current in-memory adapters
   and later with persistent profile, conversation, insight, feedback, and
   audit stores.

## Non-goals

- A FUSE mount, a Linux `/proc` implementation, symlinks, or physical runtime
  files.
- Letting an LLM choose another employee ID, query arbitrary data, or access the
  underlying database.
- Making `/proc` a command channel. Mutations belong to typed `/bin`
  capabilities and application use cases.
- Defining production database technology, encryption/KMS, retention, export,
  or deletion policy.
- Replacing `ProfileStore`, `ConversationMemoryStore`, `InsightStore`,
  `FeedbackStore`, `MessageStore`, or a future audit store with one generic
  vault database.
- Automatically treating Mastra Memory as the source of truth for all business
  state.

## Decision

Implement `/proc` and `/run` as **in-process virtual read models**. A projection
builder reads only application interfaces, applies access-scoped filtering and
sanitisation, and produces typed JSON-serializable documents. A namespace
reader can expose those documents in two ways:

1. **Prompt materialisation (first implementation):** the runtime obtains a
   fixed projection snapshot before an agent call and renders selected documents
   into the agent's structured context.
2. **Typed read capability (optional later implementation):** a tool or remote
   endpoint accepts only an allow-listed logical path and derives employee,
   thread, and permissions from trusted request context. It returns the same
   projection document; it does not accept arbitrary storage queries.

A path is consequently an API handle, not a path on disk. For example,
`/proc/profile` means “the safe profile projection for the current invocation”,
not `vault/proc/profile`, `/tmp/profile.json`, or a symbolic link to a database.

## Logical namespace and ownership

| Family | Contract | Owner/source | Read/write semantics |
|---|---|---|---|
| `/AGENTS.md` | root behavioural instructions | versioned `vault/AGENTS.md` | static, read-only |
| `/processes/*` | process index, registry, selected process files | versioned `vault/processes/*` | static, read-only at runtime |
| `/docs/*` | active methodology and boundary documents | versioned `vault/docs/*` | static, read-only at runtime |
| `/proc/*` | current scoped state | application stores and deterministic routing output | virtual, read-only |
| `/bin/*` | typed allowed actions | application use cases / Mastra tools | typed invocation, not shell |
| `/run/*` | scoped audit/action trace | domain event or audit storage | virtual, read-only |

The implementations for static files and virtual projections share a namespace
resolver only at the routing layer. Static files continue to use the ordinary
repository loader; dynamic paths never resolve to physical Git files.

## Projection documents

Each dynamic document uses an envelope so consumers can distinguish a missing
record, an empty collection, and a projection produced under a different
contract version:

```ts
type RuntimeProjection<T> = {
  schemaVersion: 1;
  path: string;
  generatedAt: string;
  scope: {
    employeeId: string;
    threadId?: string;
    requestId: string;
  };
  data: T;
};
```

`employeeId` in the envelope is for a trusted application/tool boundary and
should not be rendered into a model prompt unless necessary. The path never
encodes a second employee ID: `/proc/profile` always means the caller's
permitted profile.

### `/proc` documents

| Handle | Builder source | Intended data | Must not contain |
|---|---|---|---|
| `/proc/profile` | `ProfileStore.getProfile` | role, persona, typical tasks, AI level, response-length preference | Telegram identifiers, internal database keys, unrelated employee data |
| `/proc/consent` | `ProfileStore.getConsent` and participant state | status, accepted version/time when needed for the flow | raw invite secrets or unrelated audit metadata |
| `/proc/thread` | `ConversationMemoryStore.getRecentTurns` | bounded, current-thread turns required for continuity | other threads, other employees, unlimited history |
| `/proc/decision` | `ConversationDecisionRouter` output | selected process IDs and work/insight decisions for this turn | router prompt, provider internals, unrelated state |
| `/proc/insights` | `InsightStore.listInsights` | bounded structured insights relevant to the employee/thread | raw transcript copied into insight fields, direct identifiers |
| `/proc/feedback` | `FeedbackStore.listFeedback` | bounded feedback related to the active thread/answer when useful | feedback for other employees or threads |

The existing JSON schemas under `vault/proc/schemas/` remain the data-contract
starting point. This RFC adds the envelope and requires schemas to evolve with
any new field, documented projection limit, or visibility rule.

“Sanitized” does **not** mean that a current user message is always removed:
the agent may need a bounded amount of the employee's own conversation to answer
coherently. It means that each projection is purpose-limited, access-scoped,
field-allow-listed, bounded, and does not create a permanent Git or disk copy.

Conversation consumers use explicit, purpose-specific windows over the same
canonical snapshot. The response agent may receive up to 10 completed pairs
within the 12,000-character projection budget. The conversation decision router
receives only the newest 3 completed pairs so it can resolve local elliptical
follow-ups (for example, a confirmation or continuation request) without letting
older topics dominate the decision. Router text and history are XML-delimited,
escaped, and labelled as untrusted conversation data. Insight extraction uses a
separate bounded window after an allowed response.

### `/run` documents

`/run` exposes what happened during a current or recent invocation. It is not
an instruction source and must not affect policy selection by itself.

Initial handles:

| Handle | Builder source | Intended data |
|---|---|---|
| `/run/current` | events emitted for the current `requestId` | ordered, redacted trace of the current operation |
| `/run/recent` | audit/event store | bounded recent trace for the permitted employee/thread |

A projected event includes a stable type, timestamp, correlation/request ID,
and safe decision metadata such as selected process IDs or an insight ID. It
must exclude `ChatMessageReceived.text`, full generated answers, raw extraction
payloads, tokens, API keys, invite codes, and stack traces. The domain event
store may retain fields according to a later approved privacy policy; the `/run`
projection has a stricter agent-facing allow-list.

## Invocation lifecycle

The runtime builds state in explicit stages. This avoids an impossible snapshot
where `/proc/decision` exists before routing or `/run/current` claims that an
operation has completed before it has happened.

```text
trusted shell identity
  → application access scope (employeeId, threadId, requestId)
  → pre-decision /proc snapshot
       profile, consent, bounded thread, insights, relevant feedback
  → ConversationDecisionRouter
  → decision projection + selected process/context construction
  → agent call
  → typed application writes (/bin/use cases, insights, feedback, messages)
  → domain/audit events
  → post-action /run snapshot and optional post-action /proc refresh
```

For the initial prompt-materialisation version, the agent receives a frozen
pre-call state plus the decision and selected process context. It does not need
to read a changing world during generation. If dynamic reads are introduced,
the reader creates a new snapshot for each allowed read and labels it with
`generatedAt`; the caller must not assume cross-read transaction consistency.

## Architecture and interfaces

Add a small application-layer boundary, for example:

```text
src/application/runtime-projection.ts
src/application/runtime-namespace-reader.ts
```

The exact file names are not part of the contract. Responsibilities are:

```ts
type RuntimeAccessScope = {
  employeeId: string;
  threadId?: string;
  requestId: string;
  purpose: "chat" | "feedback" | "onboarding" | "audit";
};

type RuntimeProjectionBuilder = {
  buildProc(scope: RuntimeAccessScope): Promise<ProcSnapshot>;
  buildDecision(scope: RuntimeAccessScope, decision: ConversationDecision): ProcDecision;
  buildRun(scope: RuntimeAccessScope, options?: { limit?: number }): Promise<RunSnapshot>;
};

type RuntimeNamespaceReader = {
  read(path: AllowedRuntimePath, scope: RuntimeAccessScope): Promise<RuntimeProjection<unknown>>;
};
```

Key rules:

- The builder depends on application store interfaces, not `InMemoryWorld`, SQL,
  HTTP handlers, or Mastra internals.
- The shell resolves external identity (for example, Telegram chat identity) to
  an authenticated employee before creating `RuntimeAccessScope`.
- The reader rejects unknown paths, write modes, traversal sequences, and any
  employee/thread identifiers supplied in the path or by the model.
- The projection renderer controls field allow-lists and length limits in code;
  it does not interpolate arbitrary store records into prompts.
- `MinutkaContextBuilder` consumes a projection DTO or a deliberately rendered
  subset. It must not independently re-read a wider profile than the projection
  contract allows.
- `/bin` tools receive the same trusted scope but perform their own input
  validation and authorization. Reading `/proc` never grants write authority.

This leaves the physical storage replaceable:

```text
InMemoryWorld adapters ─┐
SQLite/libSQL adapters ─┼→ application store interfaces → projection builder
PostgreSQL adapters ────┘                                    ↓
                                                    prompt / typed reader
```

## Relation to Mastra Memory

Mastra Memory is an infrastructure facility for LLM message history. It is not
the implicit implementation of `/proc/thread`, profile, consent, insights,
feedback, or `/run`.

The current code passes `recentTurns` from `ConversationMemoryStore` into the
application/agent flow. It also configures `Memory` on `minutkaAgent`, but the
normal Telegram execution path calls the agent directly rather than through the
`Mastra` instance in `src/mastra/index.ts`; therefore that `Memory` instance is
not currently attached to the `LibSQLStore` configured there. In addition,
that store uses `url: ":memory:"` and would lose data on restart even if it
were attached.

Before enabling persistent Mastra Memory, an implementation must decide one of
the following and document the retention/privacy consequences:

1. application conversation storage is canonical and Mastra Memory is disabled
   for message history;
2. Mastra Memory is canonical for message history and an authorised application
   adapter builds `/proc/thread` from it; or
3. both remain, with non-overlapping roles and explicit duplicate-history rules.

Regardless of this decision, business state continues to be owned by typed
application stores and the runtime projection boundary remains in front of the
agent.

## Security and privacy constraints

1. **Scope before lookup.** Authorization produces `RuntimeAccessScope` before
   any store query. A model never supplies a target employee ID.
2. **Deny by default.** Unknown paths, missing employee scope, cross-thread
   access, and unsupported purposes fail closed with a safe error code.
3. **Allow-list output.** Projection code constructs output fields explicitly;
   serializing a whole domain/database record is forbidden.
4. **Bounded context.** `/proc/thread`, insights, feedback, and `/run/recent`
   have documented record and character/token limits. Limits are enforced before
   prompt rendering.
5. **No raw-state artifacts.** Do not write dynamic projection documents under
   `vault/`, `/tmp`, build output, test snapshots committed to Git, or ordinary
   application logs.
6. **Trace redaction.** `/run` is more restrictive than an internal event store.
   Raw text, provider request/response payloads, secrets, and stack traces are
   never agent-visible audit data.
7. **Schema and compatibility.** Additive changes increment the appropriate
   schema version or preserve defaults; removing/renaming fields requires a
   migration plan and updates to process/context consumers.

## Implementation plan

### Phase A — make the current boundary explicit

1. Define `RuntimeAccessScope`, typed `/proc` DTOs, safe `/run` DTOs, and
   limits in the application layer.
2. Implement a projection builder over the existing in-memory store interfaces
   and `world.events`; it must not access arrays directly outside adapters.
3. Refactor `MinutkaContextBuilder`/service orchestration to consume the
   projection subset for profile and recent-turn context.
4. Render a clearly delimited runtime context section from this snapshot.
5. Update `vault/proc` schemas and `/run` documentation to match actual output.

### Phase A implementation note (Phase 4.1)

Phase 4.1 implements `RuntimeAccessScope`, versioned envelopes, bounded
`RuntimeProjectionBuilder`, safe `AuditEventStore`, and the `/proc` prompt
renderer over application stores. `ConversationStore` is canonical and Mastra
message history remains disabled. PostgreSQL adapters preserve the same
contracts; executable specs retain the explicit in-memory runtime fixture.

### Phase B — add a namespace reader when an agent needs on-demand reads

1. Add an allow-listed `RuntimeNamespaceReader` or an equivalent typed Mastra
   tool. It supports only documented logical handles.
2. Bind scope from server-side request context; do not expose a generic
   `path + employeeId` public API.
3. Return typed JSON documents with the projection envelope and safe error
   responses.
4. Keep prompt materialisation for data that is always needed; use on-demand
   reads only for state that would otherwise bloat every prompt.

### Phase C — introduce durable storage and audit retention

1. Implement persistent adapters for the relevant application store interfaces.
2. Replace the in-memory event source with a durable audit boundary where
   product/privacy requirements approve it.
3. Keep projection DTOs and paths stable; only the adapters beneath them change.
4. Decide and wire Mastra Memory deliberately, including a persistent provider
   if message history must survive restarts.

### Phase D — optional remote transport

If an external agent runtime needs these handles, expose the namespace reader
through authenticated HTTP/RPC/MCP endpoints. The transport maps identity to
scope server-side and returns the same projection documents. It does not expose
an operating-system filesystem or database connection.

## Testing approach

### Unit tests

- Each builder maps a store record to only its allow-listed fields.
- Missing profile/consent and empty insight/feedback/event collections have
  deterministic document shapes.
- Thread, insight, feedback, and trace limits are enforced.
- Routing receives only the newest three completed pairs with escaped,
  explicitly untrusted markup and a separate field budget.
- Short follow-ups inherit the newest relevant intent, while an applicable
  business boundary cannot be bypassed by omitting the original request.
- `/run` redacts raw text and error internals.
- Invalid paths and absent/cross-scope access are rejected.

### Integration/executable specs

- A chat invocation sees only its own profile and bounded thread projection.
- The selected decision is available only after routing and agrees with the
  process context supplied to the agent.
- An insight/feedback action creates safe post-action trace records without
  exposing the message body through `/run`.
- Replacing in-memory stores with a fake persistent adapter does not change
  projection shape or path semantics.
- A restart test documents the current in-memory loss of state; after durable
  adapters exist, it proves approved data survives restart.

### Manual checks

- Inspect the rendered runtime context for a seeded employee and verify that it
  has no invite code, Telegram ID, unrelated employee data, secrets, or raw
  audit payload.
- Trigger a normal chat, a boundary decision, insight extraction, and feedback;
  confirm `/run/current` contains only safe event metadata.

## Acceptance criteria

This RFC is implemented for Phase A when all of the following are true:

- `/proc` and `/run` are generated by an application projection boundary, not
  by committing or writing live employee JSON under `vault/`.
- A trusted employee/thread/request scope is required before every projection
  store lookup.
- The rendered chat context uses an explicit projection DTO for profile and
  recent-thread data.
- Projection output has versioned schemas, field allow-lists, and bounded
  collections.
- `/run` contains no raw message text, generated response text, secrets,
  provider payloads, or stack traces.
- Existing executable specs continue to run using in-memory adapters.
- No physical filesystem mount, symlink, or temporary projection file is
  required.

## Alternatives considered

### Real temporary JSON files

Materialising `/tmp/<run>/proc/profile.json` is easy to demonstrate but creates
extra copies of personal data, requires cleanup and permissions, can leave
artifacts after crashes, and offers no benefit for the current in-process
runtime. Do not use it for the MVP.

### FUSE or a real mounted filesystem

This most closely mimics Unix `/proc`, but adds OS permissions, container
constraints, lifecycle management, and an unnecessary security surface. It is
not justified unless a future agent runtime can only consume real files.

### Give the agent direct database or generic storage access

This defeats field-level privacy rules and makes authorization dependent on LLM
behaviour. It is rejected.

### Treat a prompt string as the only contract

This is the current partial state. It is simple but hard to test, version,
reuse through tools/endpoints, or audit. Typed projection documents remain the
contract; prompt rendering is merely the first transport.
