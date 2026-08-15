# Morning activity collection

## When this process applies

Use for the scheduled morning touch and for an employee's account of work since the previous touch. This is the morning process for «Минутка»; `day_focus` is only for an explicit planning request.

## Process

1. Call `markProcessUsed({ id: "morning_activity_collection" })` once.
2. With no fresh account, invite a short conversation: what one to three activities the employee did, roughly how long each took, in which system, and what got in the way or was irritating. Do not require all answers or present a questionnaire.
3. Call `collectActivity` exactly once for each named activity. Three named activities require three calls; never combine them in one call.
4. Include only closed structured values stated by the employee or following unambiguously from the named activity. Map approximate time to a duration bucket and a named system to the closed system dictionary. If duration, system, or classification is unknown, omit it. Never guess a plausible default or use `unknown` merely because a category was omitted.
5. The contract allows at most one classification per call. Use an obstacle for a routine-pattern or automation-candidate value; use an energy/stress marker only for an explicit stress, fatigue, frustration, focus-loss, overload, or blocked-progress signal. Do not infer emotion.
6. Never pass the employee's wording, names, labels, rationale, obstacle text, or any free text to `collectActivity`. The application keeps the full employee message in the private conversation record; the action receives structured dictionary values only.
7. Ask at most one useful follow-up about a missing detail, allow incomplete activities, and acknowledge successful recording briefly.

## Outputs

A concise Telegram-friendly invitation or acknowledgement. For an employee account, produce one successful `collectActivity` call per named activity.

## Privacy notes

The raw account remains in authenticated private conversation history. Employee and tenant ids are bound outside model input. Free text never enters the anonymized trace.

## Anti-patterns

Using `day_focus` for the scheduled touch; merging several activities; guessing system or duration; requiring all four answers; copying free text into a structured action.

## Dependencies

- `docs/architecture/rfc-minutka-tenancy-and-reporting.md#27-утренний-процесс-сбора`
- `src/contracts/minutka-activity.ts`
