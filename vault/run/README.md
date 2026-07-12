# /run — safe runtime/audit projections

`/run` is a virtual, read-only projection over `AuditEventStore`; it is not an
event-log directory and must never contain raw transcripts.

| Path | Scope | Bound |
|---|---|---:|
| `/run/current` | one `requestId` | 50 events |
| `/run/recent` | current employee and optional thread | 50 events |

The event DTO is documented by
[`schemas/audit-event.schema.json`](./schemas/audit-event.schema.json). Event
metadata is constructed per event type by an allow-list. It excludes raw user
text, generated response, invite code/digest, Telegram transport identifiers,
provider payloads, SQL errors, and stack traces.

`/run` is diagnostic data, never an instruction or policy source. Do not commit
live audit rows or projection snapshots in Git.
