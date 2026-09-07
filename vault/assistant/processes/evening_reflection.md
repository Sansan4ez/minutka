# Evening reflection

## When this process applies

Use for an employee's end-of-day account, blockers, meetings, work-related energy, and comparison with the morning plan when it is visible in bounded history. It also applies to the trusted scheduled `evening_reflection` trigger.

## Inputs

- `/proc/profile`: employee preferences and optional personal working context.
- `/proc/thread`: bounded recent turns, especially the morning plan or a voluntary midday adjustment.
- Current employee text, or the trusted scheduled process instruction.

## Process

1. For a scheduled trigger without a fresh answer, call `markProcessUsed({ id: "evening_reflection" })` once and invite one compact response: what was completed or started, the main obstacle or change, optional work-related energy, and «назовите работу своими словами и, если знаете, сколько заняла и как часто повторяется». When bounded history confirms daytime activity writes, say "what else to add to what is already noted". Do not call the activity transaction or invent how the day went.
2. For fresh completed or in-progress work, call `processCurrentActivityTurn({ mode: "record" })` once. Repeated real work is a new factual episode and still uses `record`. A duration-only reply is not: use `repair` (step 3).
3. For correction/clarification (including duration-only), clear recent reference, or duplicate confirmation, call `processCurrentActivityTurn({ mode: "repair" })` once. Never infer a duplicate or supply handles, revisions, facets, identity, or raw text.
4. Wait for the typed result before claiming any write. `completed` may be acknowledged with its saved count or corrected/superseded revision. `needs_clarification` requires one short question. Several matches require one short clarification. `no_write` changes nothing. A stale revision changes nothing. `partial`, `failed`, and `outcome_unknown` are reported plainly and are not retried automatically.
5. Plans/not-started work are not factual activities; ask or omit if unclear. Extract facets only in the bounded transaction: omit unsupported fields; use `other` only for an explicit closed-taxonomy exception; a meeting or call without a channel has no system; energy/stress has no `other`. Use the compact generic mapping for systems, never a brand or internal name; otherwise omit rather than guess. For a work object, always record routineLabel and add routineId only on directory match; omit both without an object. The transaction extracts these fields and recurrence; do not ask separately or infer from history.
6. Reflect observable facts without judging productivity. When morning history is visible, compare intentions and outcomes cautiously; when it is absent, do not claim to remember a plan.
7. Suggest at most one small next step for tomorrow or the next work block. Do not use task, project, idea, document, or reminder tools.

## Outputs

- For a scheduled message: a concise invitation to report result, obstacle, and optional energy.
- For an employee answer: one request-bound activity transaction result followed by a short non-judgmental reflection and at most one next step. Never announce success before the result.

## Privacy notes

Raw reflection stays in private history and tenant-scoped research traces; structured activity records contain only closed values, bound outside model input.

## Anti-patterns

Recording plans or not-started work; asking separately for a work name; inferring recurrence from history; duplicating or merging activities; inventing fields or emotions; productivity scoring; long coaching; mutating through disabled tools.
