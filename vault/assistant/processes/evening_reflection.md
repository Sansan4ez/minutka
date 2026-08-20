# Evening reflection

## When this process applies

Use for an employee's end-of-day account, blockers, meetings, work-related energy, and comparison with the morning plan when it is visible in bounded history. It also applies to the trusted scheduled `evening_reflection` trigger.

## Inputs

- `/proc/profile`: employee preferences and optional personal working context.
- `/proc/thread`: bounded recent turns, especially the morning plan or a voluntary midday adjustment.
- Current employee text, or the trusted scheduled process instruction.

## Process

1. Call `markProcessUsed({ id: "evening_reflection" })` once.
2. For a scheduled trigger without a fresh answer, invite one compact response covering what was actually completed or started, the main obstacle or change, and optional work-related energy. When visible bounded history confirms daytime activity writes, phrase the invitation as "what else to add to what is already noted". Do not invent how the day went.
3. When the employee names factual completed or in-progress activities, call `collectActivities` once with one array item per named activity.
4. Before writing, inspect visible bounded history. Do not write an activity already confirmed as recorded in an earlier turn. If duplication cannot be ruled out, ask one short clarifying question. Do not record a priority that was only planned, postponed, or never started; if completion is ambiguous, ask one short clarifying question or omit the activity.
5. Send only closed dictionary fields stated by the employee or following unambiguously from the activity. Omit unknown values. Never pass employee wording, names, labels, rationale, obstacle text, or other free text to `collectActivities`.
6. Put an activity category and at most one obstacle per activity in the same batch call. Use an energy/stress marker only for an explicit work-related signal; do not infer emotion.
7. Reflect observable facts without judging productivity. When morning history is visible, compare intentions and outcomes cautiously; when it is absent, do not claim to remember a plan.
8. Suggest at most one small next step for tomorrow or the next work block. Do not use task, project, idea, document, or reminder tools.

## Outputs

- For a scheduled message: a concise invitation to report result, obstacle, and optional energy.
- For an employee answer: one successful `collectActivities` call containing every factual activity, followed by a short non-judgmental reflection and at most one next step.

## Privacy notes

The raw reflection stays in private conversation history and tenant-scoped research traces. Structured activities contain only closed dictionary values bound to the authenticated employee and research subject outside model input.

## Anti-patterns

Recording plans or not-started work; duplicating an activity already confirmed as recorded in visible bounded history; merging activities; inventing fields or emotions; productivity scoring; long coaching; mutating through disabled tools.
