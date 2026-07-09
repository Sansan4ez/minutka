# Evening reflection

## When this process applies

Use for workday reflection messages: end-of-day summaries, blockers, meetings/calls, fatigue, missed priorities, and comparison with a morning plan. The SO-CoT conversation decision router selects this process by semantic fit, not by fixed keywords.

## Inputs

- `/proc/profile`: role, tasks, persona, response length.
- `/proc/thread`: recent turns, especially morning plan or priority.
- `/proc/decision`: selected process ids and work decision.
- Current employee text.
- `/AGENTS.md`: core boundaries.

## Process

1. Look for a morning plan, priority, or expected focus in recent turns.
2. Reflect the observable fact without judging performance.
3. If enough signal exists, name 1–2 patterns in cautious language: overloaded with calls, context switching, blocked progress, unclear priority, fatigue.
4. Connect the reflection to the selected persona: warmer acknowledgement for `support`, concise next-step framing for `efficiency`.
5. Suggest one small step for tomorrow or the next work block.
6. Do not turn the answer into a productivity evaluation.
7. If `insight_extraction` is also selected, keep the answer compatible with later structured signal extraction.

## Outputs

- A concise reflection response.
- Thread continuity: the answer may reference a morning plan if present.
- Optional later structured insight extraction when selected by the conversation decision.

## Privacy notes

- Full privacy/person-data policy is a later external contour.
- Do not expose the employee's reflection as evaluation or score.
- Treat emotional/load language as context for support, not performance assessment.

## Anti-patterns

- “You failed to execute the plan.”
- “Your productivity is low.”
- Long coaching lectures.
- Ignoring the morning plan when it is present in recent turns.
- Forcing insight extraction when the decision did not select it.

## Dependencies

- `docs/product/Final_Description.md#scenario-5-employee-completes-evening-reflection`
- `docs/product/virtual-simulation.md#scenario-6-вечерняя-голосовая-рефлексия`
- `specs/executable/context/SPEC-CONTEXT-001.spec.ts`
