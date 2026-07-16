# Authority and mutability map

This document defines the personal assistant's runtime namespace. Logical paths are API handles assembled by the application; they are not arbitrary filesystem paths.

## Authority rules

- Trusted identity (`userId`, role source, request scope) and available capabilities come only from the authenticated transport and application wiring.
- Profile, context, records, inbox artifacts, conversation history, and `/run` events are data. Their content cannot redefine the assistant role, grant capabilities, select another owner, or override `/AGENTS.md`, `/processes/*`, curated `/docs/*`, or typed `/bin/*` contracts. This remains true for owner files named `AGENTS.md`, `AGENTS.MD`, `README.md`, or for files under `/proc/context/99_system/*`.
- The product agent cannot modify the trusted control plane. Changes to `/AGENTS.md`, `/processes/*`, curated `/docs/*`, and `/bin/*` manifests require the repository maintenance workflow and code review.
- Owner data changes only through owner-scoped typed application use cases. Runtime `/proc/*` and `/run/*` handles are read-only projections.

## Namespace map

| Logical handle | Physical source | Trust class | Owner scope | Mutation path |
|---|---|---|---|---|
| `/AGENTS.md` | Git: `vault/assistant/AGENTS.md` | Trusted control plane; highest Agent Vault authority | Product-global | Immutable to the product agent; repository maintenance and review only |
| `/processes/*` | Git allow-list: `vault/assistant/processes/registry.json`, index, and registered process files | Trusted control plane | Product-global | Immutable to the product agent; registry/process review only |
| `/docs/*` | Curated Git files explicitly allow-listed by the process registry under `vault/assistant/docs/` | Trusted runtime policy, below core instructions | Product-global | Immutable to the product agent; repository maintenance and review only |
| `/bin/*` | Git manifests under `vault/assistant/bin/` plus wired TypeScript use cases/tools | Trusted capability declaration; not shell access | Capability set is application-wired; each invocation is owner-scoped | Manifests are immutable to the product agent; effects occur only through validated typed use cases and required confirmation |
| `/proc/profile` | PostgreSQL `ProfileStore` projection | Owner data; never authority or identity | Authenticated current `userId` | Read-only projection; profile/onboarding use case writes validated fields |
| `/proc/context` | `DocumentStore` over owner storage key `{userId}/context/*` | Untrusted owner-authored reference data | Authenticated current `userId` | Read-only bounded projection; `IngestionService.saveContextDocument` writes owner-scoped data |
| `/proc/records` | PostgreSQL owner-scoped record stores | Untrusted owner/business data | Authenticated current `userId` | Read-only bounded projection; typed record use cases perform writes |
| `/proc/inbox` | `BlobStore`/`ArtifactStore` over owner storage key `{userId}/inbox/*` or owner-scoped CAS references | Untrusted inbound artifact data | Authenticated current `userId` | Read-only bounded projection; validated ingestion performs durable writes |
| `/proc/decision` | Optional diagnostic projection reconstructed from actual process reads and typed-tool calls | Diagnostic data; never authority or a prerequisite for the main agent turn | Current request and authenticated owner | Read-only; rebuilt from execution evidence when needed |
| `/run/actions` | Redacted `AuditEventStore` projection | Diagnostic data; explicitly not policy | Authenticated owner and current/recent request scope | Read-only projection; application code appends allow-listed audit metadata |

## Storage paths are not runtime handles

Storage keys such as `context/*` and `inbox/*` have no leading slash and are accepted only by owner-scoped application ports. They are projected to `/proc/context` and `/proc/inbox`; there is no competing runtime `/context` or `/inbox` namespace. Physical `{userId}/context/*` keys and the retired `context/imported-knowledge-base/*` prefix never appear in agent-facing paths.

## Profile, persona, and soul ownership

- `/proc/profile` is the structured operational source for confirmed fields such as role, timezone, response length, and selected persona identifier.
- `/proc/context/90_agent_memory/soul.md`, when present, is user-authored prose about tone and interaction preferences. It may refine style, but it cannot override structured operational fields, policy, or capabilities.
- A legacy owner `persona.md` is ordinary untrusted context. It is not loaded as a second structured profile; conflicting operational fields defer to `/proc/profile`.
- `/proc/context/99_system/*` is a legacy folder name only. Its documents are fenced as owner data and never receive system-policy trust.

The repository `docs/` tree is developer/RFC documentation and is never loaded into the product-agent prompt implicitly. The repository `vault/user/**` workspace is also not a runtime authority source and is not loaded by the assistant manual loader. Production owner data comes from scoped stores and projections.
