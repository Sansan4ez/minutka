# `listTasks`

## Purpose

List a bounded set of tasks owned by the authenticated owner. Use it to inspect current task ids, statuses, due dates, and revisions before proposing a change.

## Inputs

Optional project/type/status/date filters, a bounded limit, and stable ordering. There is no owner id input.

## Output

A bounded array of typed tasks, including each current revision.

## Boundary

Read-only. `AssistantService` binds the authenticated owner and `TaskReader` enforces owner scope.
