# `setDailySchedule`

## Purpose

Create, change, or re-enable one supported daily assistant schedule and report the saved wall-clock time.

## Inputs

A closed supported `processId`, `timeOfDay` in 24-hour `HH:mm`, and optional IANA `timezone`. There is no owner id input; omitted timezone comes from the owner profile.

## Output

A saved owner-free schedule projection, or a clear unsupported-process result.

## Confirmation level

Level 0: this is a reversible internal owner-scoped write. No prior confirmation is required; after success, report the saved schedule and name disabling or changing it as the reversal path.

## Boundary

The application binds the authenticated owner and rejects arbitrary process ids. This action does not execute an external action.
