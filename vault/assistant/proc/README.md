# /proc — owner-scoped runtime projections

`/proc` is a typed, read-only view over application stores. It is **not** a physical directory, and no owner state is written to Git, `/tmp`, or the Agent Vault.

The canonical assembly order and budgets are defined in [`docs/architecture/runtime-context-contract.md`](../../../docs/architecture/runtime-context-contract.md). This README is developer documentation and is not loaded into the product-agent prompt merely because it is named `README.md`.

Default text budget is 88,000 Unicode characters with an 8,000-character response reserve and a 2,000-character wrapper-markup allowance. The guaranteed source ceilings (manual, profile, context, and machine index) must fit statically together with maximum input and reserves; invalid combinations fail at startup.

| Path | Source | Default bound | Product chat today |
|---|---|---:|---|
| trusted assistant manual | registered `/AGENTS.md`, `/docs/*`, process index/files | source ceiling 24,000 chars | included |
| `/proc/profile` | `ProfileStore` | field allow-list; ≤4,000 chars | included after onboarding when present |
| `/proc/consent` | `ProfileStore` consent read model | bounded typed fields | used by consent/onboarding flows |
| `/proc/context` | `DocumentStore`, current owner's personal knowledge base | 12 docs; 8,000/doc; 24,000 total | included |
| `/proc/context` machine index | `DocumentStore.listMetadata`, all current-owner logical paths | 6,000 chars; depth 4; file tree → folder → top-level → fixed-size global rollup; path segments prompt-escaped | included after context documents |
| `/proc/records` | owner-scoped record stores | 24 records; 1,000/record; 12,000 total | included |
| `/proc/thread` | `ThreadSummaryStore` + `ConversationStore`, current owner and thread | summary 4,000 chars; 10 completed turns; 12,000 history chars | included when data exists |
| `/proc/insights` | `InsightStore` | bounded typed records | used by scoped flows |
| `/proc/feedback` | `FeedbackStore` | bounded typed records | used by scoped flows |
| `/proc/decision` | execution-derived request diagnostic | one request | diagnostic only |
| `/run/current`, `/run/recent` | redacted `AuditEventStore` read models | 50 events each | diagnostic only; not normal chat prompt |
| document tool turn reads | `readDocument` content + `searchDocuments` snippets | 48,000 chars/turn; list metadata is free | included on demand; exhaustion returns a typed marker |

Trusted `userId`, `threadId`, request scope, and capabilities come from the application and are never inferred from projection contents. Renderers label profile, context, records, inbox, and history as untrusted owner data and escape embedded markup. These values cannot override `/AGENTS.md`, process selection rules, or the request-scoped typed-tool set.

Owner-context navigation is tiered: the machine index is the structural source of truth; an exact-case `INDEX.md`, when present, is an untrusted semantic annotation for that folder's direct children only. Path-like code spans in `INDEX.md` follow the same import drift-check as Markdown links. Chat projection lists metadata once and lazily fetches only candidate bodies with `get()`; it never performs a full body `list()`. Core manifest matches are validated at import, while oversized lower-priority context degrades with explicit truncation/index references and metadata-only audit. LLM summarization at ingestion is deliberately not used.

Thread compaction is projection-only and non-destructive. After a successful response is durably appended, an asynchronous job processes turns that are now outside the 10-turn window and produces an incremental four-section summary. Each non-empty batch makes one provider call with a conservative output-token limit. A structured oversized result is reduced deterministically in the application: all headings and the explicit `История сокращена для лимита` marker remain, while section bodies are bounded by Unicode code points. An unstructured result is not saved. The summary watermark is an inclusive `fromMessageId..throughMessageId` range and advances only after save; raw turns remain unchanged in `ConversationStore`, and failures keep the previous valid checkpoint plus the normal history truncation marker.

Legacy schemas in `schemas/` remain for compatibility until the corresponding assistant projections receive dedicated versioned schemas. Do not commit raw messages, actual identifiers, database rows, object-storage keys containing owner ids, or production projection snapshots under `vault/assistant/proc`.
