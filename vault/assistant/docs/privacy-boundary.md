# «Минутка» privacy boundary

This is the active employee-facing `privacy-v6` pilot boundary.

- Ordinary employee messages and «Минутка» responses remain in employee-scoped canonical private conversation history for thread continuity and are also part of the tenant-scoped research corpus.
- The trusted «Алгоритм» research team can inspect the full corpus for an explicitly selected company and training group: messages, structured activities, execution traces, feedback, evidence, and evaluation labels. This access supports manual process analysis, prompt/taxonomy improvement, and evaluation.
- The pilot corpus is not used for model training or fine-tuning. Adding that purpose requires a new immutable policy version and re-consent.
- Every participant has a random group-scoped `subject_key` used to link evidence and find records for purge/recompute. It is a pseudonym, not a credential and not a promise of irreversible anonymity; the operator retains the identity mapping.
- The client company receives only a separately prepared report artifact. It has no access to raw conversations, traces, subject keys, identity mapping, research APIs, databases, or internal evidence packs. A separately agreed operational participation fact may still be communicated manually.
- Reminders select only the `lagging` label from the last touch; conversation content, activities, traces, insights, inferred reasons, and judgements are not inputs. The bot sends one predefined message itself, at most once per 24 hours and a bounded number of times, recording no touch and opening no conversation turn. Then the methodologist may contact the employee and, after prolonged absence, manually tell the company lead only the participation fact. Only the first tier is automatic; there is no operator broadcast command.
- The pilot has no automatic TTL for conversation corpus or traces. The operator performs manual retention/deletion by company, group, or subject scope. Reports not yet delivered are recomputed from the remaining canonical evidence; an already delivered client artifact is not silently recalled or replaced.
- `personal_context_review` is employee-only: safe profile fields, no ids/raw conversation/traces, owner-bound closed patch, read-only exact role. Optional context stays out of inventory, audit values, activities, and company report. Research reads stay exact scoped use cases; company delivery uses a separate DTO.
- Confirmed profile and cautious observations are separate; unverified patterns are neither facts nor automatic writes.
- Raw conversation text is not copied into structured insights, audits, or aggregates. It is intentionally retained in canonical messages and research traces. Structured insights never contain direct personal identifiers. Credential-shaped keys and values are filtered before trace persistence, but ordinary work content and names are not PII-redacted in the pilot corpus.
- The employee's chosen display name is included in bounded LLM context without masking. Phone numbers and Telegram/transport identifiers are not included in assistant projections or LLM context.
- Telegram voice audio goes transiently to the configured STT provider and is not retained by the application. Text and required context go to the configured LLM provider.
- The agent has no direct database, object-storage, shell, or arbitrary-file access. Reads use bounded projections; writes use typed application actions. External effects use their transport's explicit confirmation policy.

The active process index decides routing; typed use cases and confirmation policy decide mutations. The canonical consent wording lives in `consent_and_privacy` and the immutable public snapshot is `privacy-v6`.
