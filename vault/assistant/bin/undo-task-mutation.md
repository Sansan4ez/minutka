# `undoTaskMutation`

## Purpose

Undo the owner's most recent level-0 task mutation within the 15-minute window.

## Inputs

None. The owner and the latest eligible canonical confirmation record are bound by the authenticated application session. The model cannot choose previous values or a task id.

## Output

`undone`, `already_undone`, `not_found`, `expired`, or `conflict`. An idea-to-task undo can also return `ideaStatusConflict: true`: the task was removed, but a newer idea status was preserved and must be described as a partial undo. Report success or a clear refusal in normal prose without ids. `not_found` and `expired` are expected outcomes, not application errors.

## Confirmation level

Level 0: this is the reversible counterpart of task create/update/complete/idea-to-task.

## Boundary

The application restores server-held canonical prior state. For create it deletes the created task; for update/complete it restores previous fields; for idea-to-task it deletes the task and restores the idea's previous status only when the idea still has the expected post-conversion status and revision. Never invent or pass previous values.
