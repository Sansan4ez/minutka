# Evening reflection

## When this process applies

Use for an employee's end-of-day account, blockers, meetings, work-related energy, and comparison with the morning plan when it is visible in bounded history. It also applies to the trusted scheduled `evening_reflection` trigger.

## Inputs

- `/proc/profile`: employee preferences and optional personal working context.
- `/proc/thread`: bounded recent turns, especially the morning plan or a voluntary midday adjustment.
- Current employee text, or the trusted scheduled process instruction.

## Process

1. For a scheduled trigger without a fresh answer, call `markProcessUsed({ id: "evening_reflection" })` once and invite one compact response covering what was actually completed or started, the main obstacle or change, and optional work-related energy. When visible bounded history confirms daytime activity writes, phrase the invitation as "what else to add to what is already noted". Do not call the activity transaction or invent how the day went.
2. For fresh completed or in-progress work, call `processCurrentActivityTurn({ mode: "record" })` once. Repeated real work is a new factual episode and still uses `record`. A duration-only reply ("30 минут", "3 часа") is never new work: it goes through `repair` (step 3) and creates no new activity.
3. For correction/clarification (including duration-only), clear recent reference, or duplicate confirmation, call `processCurrentActivityTurn({ mode: "repair" })` once. Never infer a duplicate or supply handles, revisions, facets, identity, or raw text.
4. Wait for the typed result before claiming any write. `completed` may be acknowledged with its saved count or corrected/superseded revision. `needs_clarification` requires one short question. Several matches require one short clarification. `no_write` changes nothing. A stale revision changes nothing. `partial`, `failed`, and `outcome_unknown` are reported plainly and are not retried automatically.
5. Plans/not-started work are not factual activities; ask or omit if completion is unclear. Low-level facet extraction belongs only to the bounded transaction: omit unsupported fields; use `other` only for an explicit known value outside the closed taxonomy; a meeting or call without a named channel has no system; energy/stress has no `other`. System extraction uses the compact generic mapping, stores never a brand or internal name, and must otherwise omit rather than guess.
6. Reflect observable facts without judging productivity. When morning history is visible, compare intentions and outcomes cautiously; when it is absent, do not claim to remember a plan.
7. Suggest at most one small next step for tomorrow or the next work block. Do not use task, project, idea, document, or reminder tools.

## Outputs

- For a scheduled message: a concise invitation to report result, obstacle, and optional energy.
- For an employee answer: one request-bound activity transaction result followed by a short non-judgmental reflection and at most one next step. Never announce success before the result.

## Privacy notes

Raw reflection stays in private history and tenant-scoped research traces; structured activity records contain only closed values, bound outside model input.

## Anti-patterns

Recording plans or not-started work; duplicating an activity already confirmed as recorded in visible bounded history; merging activities; inventing fields or emotions; productivity scoring; long coaching; mutating through disabled tools.
