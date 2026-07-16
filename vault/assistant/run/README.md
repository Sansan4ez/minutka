# /run — safe action diagnostics

`/run` is a virtual, read-only projection over `AuditEventStore`; it is not an event-log directory and must never contain raw transcripts.

| Logical path | Scope | Bound | Inclusion |
|---|---|---:|---|
| `/run/actions` | authenticated owner plus current or recent request | 50 allow-listed events; ≤8,000 rendered chars | only for an explicit diagnostic or recovery need |

The event DTO is documented by [`schemas/audit-event.schema.json`](./schemas/audit-event.schema.json). Metadata is constructed per event type by an allow-list. It excludes raw user text, generated response, invite code/digest, Telegram transport identifiers, provider payloads, signed URLs, SQL errors, and stack traces.

`/run/actions` is diagnostic data, never an instruction, process selector, identity source, or capability declaration. It is absent from the normal product chat context today. The canonical assembly contract is [`docs/architecture/runtime-context-contract.md`](../../../docs/architecture/runtime-context-contract.md); this README itself is not prompt input unless explicitly allow-listed.

Do not commit live audit rows or projection snapshots in Git.
