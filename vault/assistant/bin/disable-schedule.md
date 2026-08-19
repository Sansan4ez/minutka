# `disableSchedule`

## Purpose

Switch off one exact morning, evening, or weekly message while preserving its delivery history. Use `listSchedules` first when the id is not already known.

## Inputs

Exact id returned by `listSchedules`. There is no employee id input.

## Output

The disabled employee-free morning/evening/weekly projection, or `not_found`. Legacy reminder ids are not accepted through this agent-facing capability.

## Confirmation level

Level 0: reversible internal employee-scoped write. After success, explain that `setDailySchedule` can turn the message back on at another time.

## Boundary

The application binds the authenticated employee and the tool first verifies that the id belongs to a model-visible morning, evening, or weekly message. It does not delete delivery history.
