# `setDailySchedule`

## Purpose

Create, change, or re-enable one supported daily assistant schedule and report the saved wall-clock time.

## Inputs

A closed supported `processId`, `timeOfDay` in 24-hour `HH:mm`, and optional IANA `timezone`. There is no owner id input; omitted timezone comes from the owner profile.

## Output

A saved owner-free schedule projection, or a clear unsupported-process result.

## Boundary

Reversible internal owner-scoped write. No external action or confirmation is required. The application binds the authenticated owner and rejects arbitrary process ids.
