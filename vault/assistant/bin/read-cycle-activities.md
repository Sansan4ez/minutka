# `readCycleActivities`

## Purpose

Return the authenticated employee's own structured activities of the last fourteen local days as counts, so the final personal report rests on the cycle that actually happened.

## Inputs

None. The employee and their timezone are bound by `AssistantService` outside model input; the window is derived from the application clock.

## Output

Counted closed-dictionary tallies for the cycle: task categories, routine patterns, automation candidates, energy/stress markers, duration buckets, and systems, plus `activityCount`, `activeDates`, `sufficientData`, `patternMinimumCount`, and `confirmedPatterns` — the values the application confirmed as repeated. It carries no free text, no subject key, no activity id, and no other participant's data.

## Boundary

Read-only and owner-scoped. It reads the employee's own canonical activities only — never another employee's rows, never a group or company aggregate, and never the prepared client report. Only a value listed in `confirmedPatterns` may be called a pattern; a false `sufficientData` means the cycle is too thin to describe two weeks, and the report must say so rather than fill the gap.
