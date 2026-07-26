# /proc — owner-scoped runtime projections

`/proc` is a typed, read-only view over application stores. It is **not** a physical directory, and no owner state is written to Git, `/tmp`, or the Agent Vault.

The canonical assembly order and budgets are defined in [`docs/architecture/runtime-context-contract.md`](../../../docs/architecture/runtime-context-contract.md). This README is developer documentation and is not loaded into the product-agent prompt merely because it is named `README.md`.

Default text budget is 88,000 Unicode characters with an 8,000-character response reserve and a 2,000-character wrapper-markup allowance. The guaranteed source ceilings (manual, profile, context, and machine index) must fit statically together with maximum input and reserves; invalid combinations fail at startup.

| Path | Source | Default bound | Product chat today |
|---|---|---:|---|
| trusted assistant manual | registered `/AGENTS.md`, `/docs/*`, process index/files | source ceiling 33,000 chars | included |
| `/proc/profile` | `ProfileStore` | field allow-list; ≤4,000 chars | included after onboarding when present |
| `/proc/context` | `DocumentStore`, current owner `context/*` | 12 docs; 8,000/doc; 24,000 total | included |
| `/proc/context` machine index | `DocumentStore.listMetadata`, all current-owner `context/*` paths | 6,000 chars; depth 4; file tree → folder → top-level rollup | included after context documents |
| `/proc/records` | owner-scoped record stores | 24 records; 1,000/record; 12,000 total | included |
| `/proc/inbox` | `ArtifactStore` / `BlobStore` | 12 relevant items; ≤8,000 chars | not included |
| recent conversation history | `ConversationStore`, current owner and thread | 10 completed turns; 12,000 chars; 6,000/turn field | included |
| `/run/actions` | request-scoped audit/action events | 50 events; ≤8,000 chars | not included |
| document tool turn reads | `readDocument` content + `searchDocuments` snippets | 48,000 chars/turn; list metadata is free | included on demand; exhaustion returns a typed marker |

Trusted `userId`, `threadId`, request scope, and capabilities come from the application and are never inferred from projection contents. Renderers label profile, context, records, inbox, and history as untrusted owner data and escape embedded markup. These values cannot override `/AGENTS.md`, process selection rules, or the request-scoped typed-tool set.

Owner-context navigation is tiered: the machine index is the structural source of truth; an exact-case `INDEX.md`, when present, is an untrusted semantic annotation for that folder's direct children only. Path-like code spans in `INDEX.md` follow the same import drift-check as Markdown links. Chat projection lists metadata once and lazily fetches only candidate bodies with `get()`; it never performs a full body `list()`. Core manifest matches are validated at import, while oversized lower-priority context degrades with explicit truncation/index references and metadata-only audit. LLM summarization at ingestion is deliberately not used.

Legacy schemas in `schemas/` remain for compatibility until the corresponding assistant projections receive dedicated versioned schemas. Do not commit raw messages, actual identifiers, database rows, object-storage keys containing owner ids, or production projection snapshots under `vault/assistant/proc`.
