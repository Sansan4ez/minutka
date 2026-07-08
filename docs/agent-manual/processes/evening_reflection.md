# Evening reflection

## When this process applies

Use for workday reflection messages: end-of-day summaries, blockers, meetings/calls, fatigue, missed priorities, and comparison with a morning plan. Main signals are policy reasons `workday_reflection` and `work_emotional_state`, or recent morning-plan context plus outcome/blocker text.

## Inputs

- `/proc/profile`: role, tasks, persona, response length.
- `/proc/thread`: recent turns, especially morning plan or priority.
- `/proc/policy`: work policy decision and insight extraction flag.
- Current employee text.
- `/AGENTS.md`: core boundaries and privacy baseline.

## Process

1. Look for a morning plan, priority, or expected focus in recent turns.
2. Reflect the observable fact without judging performance.
3. If enough signal exists, name 1–2 patterns in cautious language: overloaded with calls, context switching, blocked progress, unclear priority, fatigue.
4. Connect the reflection to the selected persona: warmer acknowledgement for `support`, concise next-step framing for `efficiency`.
5. Suggest one small step for tomorrow or the next work block.
6. Do not turn the answer into a productivity evaluation.
7. Allow insight extraction only when `policy.shouldExtractInsights = true`.

## Outputs

- A concise reflection response.
- Optional structured insight extraction trigger via application policy.
- Thread continuity: the answer may reference a morning plan if present.

## Privacy notes

- Do not store the raw reflection text inside insights.
- Treat emotional signals as private personal context; aggregate only through privacy-safe signals.
- Do not disclose specific tasks or emotional states to company/methodologist views.

## Anti-patterns

- “You failed to execute the plan.”
- “Your productivity is low.”
- Long coaching lectures.
- Ignoring the morning plan when it is present in recent turns.
- Creating insights when the policy says extraction is disabled.

## Dependencies

- `docs/product/Final_Description.md#scenario-5-employee-completes-evening-reflection`
- `docs/product/virtual-simulation.md#scenario-6-вечерняя-голосовая-рефлексия`
- `specs/executable/context/SPEC-CONTEXT-001.spec.ts`
