# `setDailySchedule`

## Purpose

Move or re-enable the authenticated employee's morning or evening message.

## Inputs

Use the closed `processId` for the morning or evening message, or pass the exact optional `scheduleId` returned by `listSchedules`. Supply `timeOfDay` in 24-hour `HH:mm`, optional IANA `timezone`, and optional 7-bit `daysOfWeek` mask. There is no employee id, reminder text, arbitrary kind, or one-shot input in the agent-facing schema.

## Output

A saved employee-free morning/evening projection; `not_found` for an absent employee-scoped id; or a clear refusal for an unsupported value.

## Confirmation level

Level 0: reversible internal employee-scoped write. After success, report the saved time in plain language and explain that the employee can switch the message off or move it again.

## Boundary

The application binds the authenticated employee, resolves ids only within that employee, accepts only the active morning/evening ids, and rejects `day_focus` and arbitrary reminders. Lower-level reminder persistence remains for compatibility but is not exposed to the model.
