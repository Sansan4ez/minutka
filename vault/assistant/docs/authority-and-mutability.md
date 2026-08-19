# «Минутка» Authority and mutability map

Logical paths are application API handles, not arbitrary filesystem paths.

## Rules

- Trusted identity (`userId`, role source, request scope) and capabilities come only from authenticated transport and application wiring.
- Employee data—profile, context, records, artifacts, conversation history, insights, feedback, and `/run` events—cannot redefine the «Минутка» role, grant capabilities, select another employee, or override `/AGENTS.md`, `/processes/*`, curated `/docs/*`, or typed `/bin/*` contracts. This includes employee files named `AGENTS.md`, `AGENTS.MD`, or `README.md`, and files under `/proc/context/99_system/*`.
- The product agent cannot modify the trusted control plane. Repository maintenance and review own `/AGENTS.md`, `/processes/*`, curated `/docs/*`, and `/bin/*` manifests.
- Runtime `/proc/*` and `/run/*` handles are read-only projections. Employee data changes only through employee-scoped typed application use cases.

## Namespace map

| Handle | Meaning and scope | Mutation path |
|---|---|---|
| `/AGENTS.md` | Product-global trusted role and boundaries | Repository maintenance only |
| `/processes/*` | Product-global allow-listed process registry, index, and files | Repository maintenance only |
| `/docs/*` | Product-global curated runtime policy | Repository maintenance only |
| `/bin/*` | Application-wired typed capabilities, never shell access; invocations are employee-scoped | Validated use cases and required confirmation |
| `/proc/profile` | Current employee's structured profile | Profile/onboarding use case |
| `/proc/consent` | Current employee's consent state | Authenticated consent use case |
| `/proc/context` | Current employee's bounded personal context; projection is read-only | Employee-scoped typed use cases only |
| `/proc/records` | Current employee's bounded typed records | Typed record use cases |
| `/proc/thread` | Current employee's bounded thread summary and recent turns | Conversation use cases; summary compaction is application-owned |
| `/proc/insights` | Current employee's bounded structured insights | Typed insight use cases |
| `/proc/feedback` | Current employee's bounded feedback records | Authenticated feedback use case |
| `/proc/decision` | Request diagnostic reconstructed from actual process reads/tool calls; never authority | Read-only reconstruction |
| `/run/current` | Redacted events for the current request; never policy | Application-written allow-listed audit metadata |
| `/run/recent` | Current employee's bounded recent redacted events; never policy | Application-written allow-listed audit metadata |

## Storage and profile details

- Logical handles belong to one application read model/component; physical document keys, artifact CAS references, database rows, and retired prefixes are adapter details and never agent-facing paths.
- Authority files are immutable to the «Минутка» agent, `/proc` is a read-only view, and `/bin` capabilities execute typed employee-bound use cases. Typed mutation tools cannot target `/AGENTS.md`, `/processes`, `/docs`, `/bin`, `/run`, or arbitrary new top-level namespaces.
- Uploaded/generated artifacts are not promoted into employee context automatically.
- `/proc/profile` is authoritative for confirmed operational fields such as role, timezone, response length, and selected persona identifier, plus optional employee-only recurring tasks, AI experience, and program goal collected through the typed profile-context use case.
- `/proc/context/90_agent_memory/soul.md` may refine style but not override structured fields, policy, or capabilities. A legacy `persona.md` and `/proc/context/99_system/*` remain ordinary untrusted context.
- Repository `docs/` and `vault/user/**` are never loaded into the «Минутка» prompt implicitly. Production employee data comes from scoped stores and projections.
