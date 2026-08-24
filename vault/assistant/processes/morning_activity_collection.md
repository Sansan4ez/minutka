# Morning activity collection

## When this process applies

Use for the scheduled morning touch and for an employee's account of work since the previous touch. This is the active morning process for «Минутка».

## Process

1. Call `markProcessUsed({ id: "morning_activity_collection" })` once.
2. With no fresh account, invite a short conversation: what activities the employee did, roughly how long each took, in which system, and what got in the way or was irritating. Do not require all answers or present a questionnaire.
3. Send one `collectActivities` item per named activity; split in input order only above 50 items.
4. Include only closed values stated by the employee or following unambiguously from the activity. For system and every obstacle facet: unnamed/unknown → omit; unambiguously covered → concrete enum; explicitly known but not covered → `other` where that enum has it. For systems, use the compact generic mapping in the `collectActivities` tool description; store only its enum, never a brand or internal name. An unfamiliar brand maps to a generic type only when context makes that type unambiguous; otherwise omit rather than guess. A meeting or call without a named channel has no system. Never use `unknown` for an omitted category.
5. Put the category and at most one obstacle in the same item. The energy/stress facet has no `other`: use a concrete marker only for an explicit covered work-related signal. Ordinary meetings, calls, work, and template preparation without named friction have no obstacle. Do not infer emotion. Keep category and obstacle comparable across repetitions; never drop either just to fit the row.
6. Never pass the employee's wording, names, labels, rationale, obstacle text, or any free text to `collectActivities`. The application keeps the full employee message in the private conversation record; the action receives structured dictionary values only.
7. If the same ordinary account explicitly reveals a recurring task, AI experience, or the employee's own goal for the program, call `updatePersonalContext` once with a short bounded summary of only those facts. Do not ask for the missing profile fields and do not delay activity collection.
8. Ask at most one useful follow-up about a missing activity detail, allow incomplete activities and profile context, and acknowledge successful recording briefly.

## Outputs

A concise Telegram-friendly invitation or acknowledgement, with all named activities saved in bounded `collectActivities` calls.

## Privacy notes

The raw account remains in authenticated private conversation history and the tenant-scoped research trace. Employee and tenant ids are bound outside model input. Structured activities contain only closed dictionary values. Personal context fields stay in the employee profile and are excluded from company reporting.

## Anti-patterns

Turning the scheduled touch into priority planning; merging several activities; guessing system or duration; requiring all four answers; copying free text into a structured action.

## Dependencies

- `docs/architecture/rfc-minutka-tenancy-and-reporting.md#27-утренний-процесс-сбора`
- `src/contracts/minutka-activity.ts`
