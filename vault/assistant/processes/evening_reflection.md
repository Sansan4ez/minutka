# Evening reflection

## When this process applies

Use for an employee's workday reflection: end-of-day summaries, blockers, meetings/calls, fatigue, missed priorities, and comparison with the morning account when available. It also applies when application code supplies the trusted scheduled `evening_reflection` trigger. «Минутка» selects this process by semantic fit in the main answer turn, not by fixed keywords or a separate pre-flight router.

## Inputs

- `/proc/profile`: employee preferences, persona, response length, and timezone.
- `/proc/thread`: recent turns, especially the morning activity account or a later workday update.
- `/proc/context` and `/proc/records`: bounded employee context when relevant.
- Current employee text, or the trusted scheduled process instruction supplied by application code.
- `/AGENTS.md`: core boundaries.

## Process

1. Call `markProcessUsed({ id: "evening_reflection" })` once when you apply this process. This records request diagnostics only and grants no capability or authority.
2. Look for the morning activity account or a later workday update in recent turns.
3. For a scheduled trigger without a fresh employee reflection, invite a short check-in instead of inventing how the day went. Ask for the outcome, the main obstacle or change, and optionally the employee's energy in one compact prompt.
4. When the employee has supplied reflection details, reflect observable facts without judging performance.
5. If enough signal exists, name one or two patterns in cautious language: overloaded with calls, context switching, blocked progress, unclear priority, or fatigue. Do not infer a pattern from silence or from the schedule itself.
6. Connect the reflection to the selected persona: warmer acknowledgement for `support`, concise next-step framing for `efficiency`.
7. Suggest one small step for tomorrow or the next work block.
8. Keep the process read-only. Do not mutate records through tools belonging to disabled processes.
9. Do not turn the answer into a productivity evaluation.

## Outputs

- For a scheduled touch: a concise invitation to reflect, suitable for Telegram.
- For an employee response: a concise reflection with one small next step.
- Thread continuity: the answer may reference the morning activity account if present.

## Privacy notes

- Use only the current employee's bounded projections and employee-scoped typed capabilities.
- Do not expose the employee's reflection as evaluation or score.
- Treat emotional or load language as context for support, not performance assessment.

## Anti-patterns

- “You failed to execute the plan.”
- “Your productivity is low.”
- Long coaching lectures.
- Ignoring the morning activity account when it is present in recent turns.
- Inventing an end-of-day result, blocker, meeting, or emotional state for a scheduled touch.
- Mutating a record through a tool that belongs to a disabled process.

## Dependencies

Developer provenance only. These repository files are validated by maintainers and are not runtime inputs or prompt content.

- `docs/product/Final_Description.md#scenario-5-employee-completes-evening-reflection`
- `docs/product/virtual-simulation.md#scenario-6-вечерняя-голосовая-рефлексия`
- `specs/executable/context/SPEC-CONTEXT-001.spec.ts`
