# /proc — owner-scoped runtime projections

`/proc` is a typed, read-only view over application stores. It is **not** a physical directory, and no owner state is written to Git, `/tmp`, or the Agent Vault.

The canonical assembly order and budgets are defined in [`docs/architecture/runtime-context-contract.md`](../../../docs/architecture/runtime-context-contract.md). This README is developer documentation and is not loaded into the product-agent prompt merely because it is named `README.md`.

| Path | Source | Target bound | Product chat today |
|---|---|---:|---|
| `/proc/profile` | `ProfileStore` | field allow-list; ≤4,000 chars | not included |
| `/proc/context` | `DocumentStore`, current owner `context/*` | 12 docs; 4,000/doc; 16,000 total | included |
| `/proc/records` | owner-scoped record stores | 24 records; 1,000/record; 12,000 total | included |
| `/proc/inbox` | `ArtifactStore` / `BlobStore` | 12 relevant items; ≤8,000 chars | not included |
| recent conversation history | `ConversationStore`, current owner and thread | 10 completed turns; 12,000 chars | not included |
| `/proc/decision` | reconstruction from actual process/tool execution | one request | diagnostic only |

Trusted `userId`, `threadId`, request scope, and capabilities come from the application and are never inferred from projection contents. Renderers label profile, context, records, inbox, and history as untrusted owner data and escape embedded markup. These values cannot override `/AGENTS.md`, process selection rules, or the request-scoped typed-tool set.

Legacy schemas in `schemas/` remain for compatibility until the corresponding assistant projections receive dedicated versioned schemas. Do not commit raw messages, actual identifiers, database rows, object-storage keys containing owner ids, or production projection snapshots under `vault/assistant/proc`.
