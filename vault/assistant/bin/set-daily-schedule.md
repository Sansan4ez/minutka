# `setDailySchedule`

## Purpose

Create, change, or re-enable a supported process schedule or reminder and report the saved wall-clock time.

## Inputs

`kind` defaults to `process`. Process schedules use a closed supported `processId`; reminders use bounded `reminderText` (1–512 characters). Pass the exact optional `scheduleId` from `listSchedules` to change or re-enable an existing reminder in place; omit it to create another reminder. All schedules take `timeOfDay` in 24-hour `HH:mm`, optional IANA `timezone`, optional 7-bit `daysOfWeek` mask (Monday is bit 0; 127 means every day), and optional `oneShot`. A one-shot uses the nearest future occurrence of the supplied time: today when still ahead, otherwise the next allowed day. There is no owner id input; omitted timezone comes from the owner profile.

## Output

A saved owner-free schedule projection with kind, action text/process, days, one-shot state, time, timezone, enabled state, and next fire time; `not_found` for an absent owner-scoped `scheduleId`; or a clear refusal for an unsupported process or schedule-kind change.

## Confirmation level

Level 0: this is a reversible internal owner-scoped write. No prior confirmation is required; after success, report the saved schedule and name disabling or changing it as the reversal path.

## Boundary

The application binds the authenticated owner, resolves `scheduleId` only within that owner, rejects schedule-kind changes and arbitrary process ids, validates reminder text and recurrence fields, and generates private reminder schedule ids. This action does not execute an external action.
