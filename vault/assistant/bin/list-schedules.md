# `listSchedules`

## Purpose

List process and reminder schedules owned by the authenticated owner before changing or describing them.

## Inputs

No inputs. There is no owner id input.

## Output

A bounded owner-free projection containing only `id`, `kind`, optional `processId` or bounded `reminderText`, `daysOfWeek`, `oneShot`, `timeOfDay`, `timezone`, `enabled`, and `nextFireAt`.

## Boundary

Read-only. `AssistantService` binds the authenticated owner and the typed schedule use-case enforces owner scope.
