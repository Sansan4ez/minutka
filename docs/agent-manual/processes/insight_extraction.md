# Insight extraction

## When this process applies

Use only when `policy.shouldExtractInsights = true`. Typical sources are work plans, workday reflections, blockers, repeated routines, workload/energy signals, and automation-candidate descriptions.

## Inputs

- Current employee text and agent response.
- `/proc/profile`: role and typical tasks, sanitized.
- `/proc/thread`: recent turns for context, not for raw copying.
- `/proc/policy`: relevance and reason.
- `sourceMessageId` and `threadId` from application service.

## Process

1. Confirm that the application policy allows extraction.
2. Create only supported insight kinds: `task_category`, `routine_pattern`, `energy_stress_marker`, `automation_candidate`.
3. Normalize labels and rationale into short work signals.
4. Link every insight to `sourceMessageId` and `threadId`.
5. Avoid raw quotes unless a future privacy review explicitly allows them.
6. Skip extraction for blocked/out-of-scope prompts.

## Outputs

- Privacy-safe `StructuredInsight` drafts.
- No raw transcript in labels or rationale.
- Stable source linkage for audit and later correction/deletion.

## Privacy notes

- Do not store real names, Telegram IDs, usernames, emails, phone numbers, external IDs, or direct personal details.
- Emotional or stress markers are personal context and may be aggregated only through privacy rules.
- Prefer cautious, low-granularity categories over highly identifying details.

## Anti-patterns

- Copying the full user text into an insight label.
- Inferring performance quality or ranking the employee.
- Creating insights when `policy.shouldExtractInsights = false`.
- Storing PII because it appeared in the message.

## Dependencies

- `src/domain/insights.ts`
- `specs/executable/context/SPEC-CONTEXT-001.spec.ts`
- `docs/plans/phase-3-context-guardrails-insights.md`
