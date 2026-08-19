# `listSchedules`

## Purpose

List the authenticated employee's morning, evening, and weekly message times before changing or describing them.

## Inputs

No inputs. There is no employee id input.

## Output

A bounded employee-free projection containing only the exact id, closed morning/evening/weekly `processId`, days, time, timezone, enabled state, and next delivery time. Legacy reminder rows are not model-visible.

## Boundary

Read-only. `AssistantService` binds the authenticated employee and the typed use-case enforces owner scope.
