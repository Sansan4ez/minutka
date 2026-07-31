# `disableSchedule`

## Purpose

Disable one exact owner schedule while preserving its fire history. Use `listSchedules` first when the id is not already known.

## Inputs

Exact schedule id. There is no owner id input.

## Output

The disabled owner-free schedule projection, or `not_found`.

## Boundary

Reversible internal owner-scoped write. It sets `enabled=false`; it does not delete the schedule or fire history. Another `setDailySchedule` call re-enables the process.
