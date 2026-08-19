# «Минутка» privacy boundary

This is the active employee-facing `privacy-v6` pilot boundary.

- Ordinary employee messages and «Минутка» responses remain in employee-scoped canonical private conversation history for thread continuity and are also part of the tenant-scoped research corpus.
- The trusted «Алгоритм» research team can inspect the full corpus for an explicitly selected company and training group: messages, structured activities, execution traces, feedback, evidence, and evaluation labels. This access supports manual process analysis, prompt/taxonomy improvement, and evaluation.
- The pilot corpus is not used for model training or fine-tuning. Adding that purpose requires a new immutable policy version and re-consent.
- Every participant has a random group-scoped `subject_key` used to link evidence and find records for purge/recompute. It is a pseudonym, not a credential and not a promise of irreversible anonymity; the operator retains the identity mapping.
- The client company receives only a separately prepared report artifact. It has no access to raw conversations, traces, subject keys, identity mapping, research APIs, databases, or internal evidence packs. A separately agreed operational participation fact may still be communicated manually.
- Reminders select only exact company/group `lagging` / `dropped_off` labels from the last touch; conversation content, activities, traces, insights, inferred reasons, and judgements are not inputs. The operator previews full text plus eligible-recipient count and confirms outside the model loop; cooldown is 24 hours per employee. Then the methodologist may contact the employee and, after prolonged absence, manually tell the company lead only the participation fact. Tiers are not automatic; the skills map says whether group delivery is connected.
- The pilot has no automatic TTL for conversation corpus or traces. The operator performs manual retention/deletion by company, group, or subject scope. Reports not yet delivered are recomputed from the remaining canonical evidence; an already delivered client artifact is not silently recalled or replaced.
- Personal context and employee-facing actions remain isolated to the authenticated employee. Research reads cross employee boundaries only through exact company/group-scoped typed use cases; company delivery uses a separate DTO without raw evidence.
- Raw conversation text is not copied into structured insights, audits, or aggregates. It is intentionally retained in canonical messages and research traces. Structured insights never contain direct personal identifiers. Credential-shaped keys and values are filtered before trace persistence, but ordinary work content and names are not PII-redacted in the pilot corpus.
- The employee's chosen display name is included in bounded LLM context without masking. Phone numbers and Telegram/transport identifiers are not included in assistant projections or LLM context.
- Telegram voice audio goes transiently to the configured STT provider and is not retained by the application. Text and required context go to the configured LLM provider.
- The agent has no direct database, object-storage, shell, or arbitrary-file access. Reads use bounded projections; writes use typed application actions. External effects use their transport's explicit confirmation policy.

The active process index decides routing; typed use cases and confirmation policy decide mutations. The canonical consent wording lives in `consent_and_privacy` and the immutable public snapshot is `privacy-v6`.
