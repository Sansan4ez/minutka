# `disableSchedule`

## Purpose

Disable one exact owner schedule while preserving its fire history. Use `listSchedules` first when the id is not already known.

## Inputs

Exact schedule id. There is no owner id input.

## Output

The disabled owner-free schedule projection, or `not_found`.

## Confirmation level

Level 0: this is a reversible internal owner-scoped write. No prior confirmation is required; after success, name `setDailySchedule` re-enablement as the reversal path.

## Boundary

It sets `enabled=false`; it does not delete the schedule or fire history. Another `setDailySchedule` call re-enables the process.
