# `readWeeklyActivities`

## Purpose

Return the authenticated employee's own structured activities of the last seven local days as counts, so the weekly summary describes a real week instead of a remembered one.

## Inputs

None. The employee and their timezone are bound by `AssistantService` outside model input; the window is derived from the application clock.

## Output

Counted closed-dictionary tallies for the window: task categories, routine patterns, automation candidates, energy/stress markers, duration buckets, and systems, plus `activityCount`, `activeDates`, and `sufficientData`. It also returns up to three `routines` (`label`, `count`, `activeDates`, and optional `statedRecurrence`) grouped from this employee's own labelled activities. It carries no hours, free text beyond the employee's routine labels, routine id, subject key, activity id, evidence refs, or other participant's data.

## Boundary

Read-only and owner-scoped. It reads the employee's own canonical activities only — never another employee's rows, never a group or company aggregate, and never the prepared client report. A false `sufficientData` means the window is too thin to name a pattern; the process must say so rather than fill the gap.
