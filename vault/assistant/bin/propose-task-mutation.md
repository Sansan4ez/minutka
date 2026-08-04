# `proposeTaskMutation`

## Purpose

Prepare one typed task operation per assistant turn: create, update, complete, or cancel an owner task.

## Inputs

Task content or a current task id plus expected revision. The tool does not accept an owner id, a generated task id, `originIdeaId`, or terminal status through a generic update.

## Output

For `create`, `update`, and `complete`, the model receives `status: applied`, the safe task view, and `undoAvailable: true`; the canonical confirmation record and previous state stay private. Report the result in one normal sentence and add “Скажи «отмени», если не то”, without task or confirmation ids. For `cancel`, the model receives only the safe pending-action receipt; the application owns the owner-visible confirmation card.

## Confirmation level

- `create`, `update`, and `complete` are level 0: reversible internal owner-scoped writes. When the application returns an applied result, report it in normal prose and name the worded undo path; do not ask for prior confirmation.
- `cancel` is level 1: destructive but recoverable. Ask once in normal prose and explicitly say the owner can answer «да» or press the button; both paths resolve the same authenticated confirmation outside the agent loop.

## Boundary

The current typed result is authoritative: claim a change only for `status: applied`; never claim a pending cancellation changed a task. A second task operation in the same turn fails deterministically. Confirmation or rejection, when required, is an authenticated application command outside the agent tool loop; transports never submit owner id, digest, or authoritative proposal payload. A plain “отмени” after an applied task write is handled by `undoTaskMutation`, which restores server-held canonical state.
