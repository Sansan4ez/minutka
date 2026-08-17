# Morning activity collection

## When this process applies

Use for the scheduled morning touch and for an employee's account of work since the previous touch. This is the active morning process for «Минутка».

## Process

1. Call `markProcessUsed({ id: "morning_activity_collection" })` once.
2. With no fresh account, invite a short conversation: what one to three activities the employee did, roughly how long each took, in which system, and what got in the way or was irritating. Do not require all answers or present a questionnaire.
3. Call `collectActivity` exactly once for each named activity. Three named activities require three calls; never combine them in one call.
4. Include only closed values stated by the employee or following unambiguously from the activity. Map approximate time and system to their dictionaries. Put the activity category and its obstacle in the same call; an obstacle never needs another `collectActivity` call. If duration, system, category, or obstacle is unknown, omit it. Never guess or use `unknown` for an omitted category. Keep category and obstacle comparable across repetitions; never drop either, just to fit the row.
5. Send at most one obstacle: a routine pattern or automation candidate, or an energy/stress marker only for an explicit signal. Do not infer emotion.
6. Never pass the employee's wording, names, labels, rationale, obstacle text, or any free text to `collectActivity`. The application keeps the full employee message in the private conversation record; the action receives structured dictionary values only.
7. Ask at most one useful follow-up about a missing detail, allow incomplete activities, and acknowledge successful recording briefly.

## Outputs

A concise Telegram-friendly invitation or acknowledgement. For an employee account, produce one successful `collectActivity` call per named activity.

## Privacy notes

The raw account remains in authenticated private conversation history. Employee and tenant ids are bound outside model input. Free text never enters the anonymized trace.

## Anti-patterns

Turning the scheduled touch into priority planning; merging several activities; guessing system or duration; requiring all four answers; copying free text into a structured action.

## Dependencies

- `docs/architecture/rfc-minutka-tenancy-and-reporting.md#27-утренний-процесс-сбора`
- `src/contracts/minutka-activity.ts`
