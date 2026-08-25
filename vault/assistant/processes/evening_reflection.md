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
3. Send one `collectActivities` item per completed or in-progress fact; split in input order only above 50 items.
4. Repeated real work is a new factual episode. Only for an explicit correction/clarification, a clear recent reference, or explicit duplicate confirmation, call `readRecentOwnActivities`, never before ordinary writes. Several matches require one short clarification; no match changes nothing. For one unambiguous candidate, call `correctRecentActivity` with its exact handle/revision and patch only supplied facets or replace the closed facet set when the employee explicitly corrects the whole classification. For an unambiguous confirmed duplicate pair, call `supersedeRecentActivity`: the duplicate handle is excluded from current summaries/report while provenance remains. A stale revision changes nothing; do not guess or retry. Plans/not-started work are not factual activities; ask or omit if completion is unclear.
5. Send closed values only. Facets require message evidence: omit unnamed/unsupported system or obstacles; `other` requires an explicit uncovered value. Use the compact generic mapping in the tool; store only its enum, never a brand or internal name. Map an unfamiliar brand only when its generic type is unambiguous; otherwise omit rather than guess. A meeting or call without a named channel has no system. Never pass free text.
6. Put every explicit routine, automation, and energy/stress facet in one item. Energy/stress has no other; neutral requires an explicit signal. Normal work without named friction has no routine pattern. Do not infer emotion. Correct schema rejection in-turn; persistence failures are final.
7. Reflect observable facts without judging productivity. When morning history is visible, compare intentions and outcomes cautiously; when it is absent, do not claim to remember a plan.
8. Suggest at most one small next step for tomorrow or the next work block. Do not use task, project, idea, document, or reminder tools.

## Outputs

- For a scheduled message: a concise invitation to report result, obstacle, and optional energy.
- For an employee answer: all factual activities saved in the smallest number of bounded `collectActivities` calls, or a plainly reported failure with the saved count, followed by a short non-judgmental reflection and at most one next step.

## Privacy notes

Raw reflection stays in private history and tenant-scoped research traces; structured activity records contain only closed values, bound outside model input.

## Anti-patterns

Recording plans or not-started work; duplicating an activity already confirmed as recorded in visible bounded history; merging activities; inventing fields or emotions; productivity scoring; long coaching; mutating through disabled tools.
