# /proc — scoped runtime-state projections

`/proc` is an in-process, typed read model over application stores. It is **not**
a physical directory containing employee data and no runtime state is written to
Git, `/tmp`, or the vault.

Every document has the versioned `RuntimeProjection` envelope in
[`schemas/runtime-projection-envelope.schema.json`](./schemas/runtime-projection-envelope.schema.json).
The `employeeId` in its scope is trusted application metadata and is not rendered
into the LLM prompt by default.

| Path | Source | Bound |
|---|---|---:|
| `/proc/profile` | `ProfileStore` | field allow-list |
| `/proc/consent` | `ProfileStore` | no invite secret/digest |
| `/proc/thread` | `ConversationStore` | 10 turns / 12,000 Unicode chars |
| `/proc/decision` | conversation router | one request |
| `/proc/insights` | `InsightStore` | 20 records |
| `/proc/feedback` | `FeedbackStore` | 20 records |

The prompt renderer places trusted Agent Vault instructions first. Stored turns
are then explicitly labelled **untrusted conversation data**; quoted content
cannot override trusted instructions. The response agent receives the bounded
`/proc/thread` suffix (up to 10 pairs / 12,000 Unicode characters). The decision
router uses only the newest 3 completed pairs, with a separate per-field budget,
to resolve short follow-ups without allowing stale history to dominate routing.

Do not commit raw employee messages, actual identifiers, database rows, or
production projection snapshots under `vault/proc`.
