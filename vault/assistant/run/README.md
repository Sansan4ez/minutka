# /run — safe action diagnostics

`/run` is a virtual, read-only projection over `AuditEventStore`; it is not an event-log directory and must never contain raw transcripts.

| Logical path | Scope | Bound | Inclusion |
|---|---|---:|---|
| `/run/current` | authenticated owner plus current request | 50 allow-listed events | explicit diagnostic or recovery use |
| `/run/recent` | authenticated owner plus current thread when present | 50 allow-listed events | explicit diagnostic or recovery use |

The event DTO is documented by [`schemas/audit-event.schema.json`](./schemas/audit-event.schema.json). Metadata is constructed per event type by an allow-list. It excludes raw user text, generated response, invite code/digest, Telegram transport identifiers, provider payloads, signed URLs, SQL errors, and stack traces. Task proposal/decision facts expose only `confirmationId`, `actionKind`, `status`/`result`, and `taskId` when available; title, project, owner content, and the canonical proposal/outcome payload are never projected.

Both handles are diagnostic data, never instructions, process selectors, identity sources, or capability declarations. They are absent from the normal product chat context. The canonical assembly contract is [`docs/architecture/runtime-context-contract.md`](../../../docs/architecture/runtime-context-contract.md); this README itself is not prompt input unless explicitly allow-listed.

Do not commit live audit rows or projection snapshots in Git.
