# Insight extraction

## When this process applies

Use when the SO-CoT conversation decision router marks an allowed turn as an insight candidate. Typical sources are work plans, workday reflections, blockers, repeated routines, workload/energy signals, and automation-candidate descriptions. This process decides business-signal extraction, not full privacy/person-data compliance.

## Inputs

- `/proc/decision`: `insightDecision.candidate`, suggested insight kinds, selected process ids.
- Current employee text and agent response.
- `/proc/profile`: role and typical tasks, if available.
- `/proc/thread`: recent turns for context.
- `sourceMessageId` and `threadId` from application service.

## Process

1. Confirm that the conversation decision selected this process and `insightDecision.candidate = true`.
2. Create only supported insight kinds: `task_category`, `routine_pattern`, `energy_stress_marker`, `automation_candidate`.
3. Normalize labels and rationale into short business signals.
4. Link every insight to `sourceMessageId` and `threadId`.
5. Prefer low-granularity business categories over highly specific personal narratives.
6. Skip extraction for blocked/out-of-scope turns.

## Outputs

- StructuredInsight drafts.
- Short labels/rationale suitable for later aggregation.
- Stable source linkage for audit and later correction/deletion.

## Privacy notes

- Full privacy, retention, deletion, masking, and legal personal-data policy are a later external contour.
- For the prototype, this process keeps extraction narrow by shape: short structured business signals, not full transcript copying.
- Emotional/load markers are treated as workday context signals, not employee evaluation.

## Anti-patterns

- Copying the full user text into an insight label.
- Inferring performance quality, ranking, or blame.
- Creating insights when the decision did not select `insight_extraction`.
- Treating this process as the complete privacy policy.

## Dependencies

Developer provenance only. These repository files are validated by maintainers and are not runtime inputs or prompt content.

- `src/domain/insights.ts`
- `src/domain/conversation-decision.ts`
- `specs/executable/context/SPEC-CONTEXT-001.spec.ts`
- `docs/architecture/minutka-foundation.md`
