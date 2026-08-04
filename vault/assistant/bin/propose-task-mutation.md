# `proposeTaskMutation`

## Purpose

Prepare one typed task operation per assistant turn: create, update, complete, or cancel an owner task.

## Inputs

Task content or a current task id plus expected revision. The tool does not accept an owner id, a generated task id, `originIdeaId`, or terminal status through a generic update.

## Output

The model and serialized tool trace receive only the safe pending-action receipt: opaque confirmation id, action kind, bounded human-readable summary, and expiry. The canonical pending record is captured privately by `AssistantService` and is not part of the tool output. Do not quote or render the receipt, task id, confirmation id, or confirmation instructions in the assistant response; the application owns the owner-visible confirmation card.

## Confirmation level

- `create`, `update`, and `complete` are level 0: reversible internal owner-scoped writes. When the application returns an applied result, report it in normal prose and name the worded undo path; do not ask for prior confirmation.
- `cancel` is level 1: destructive but recoverable. Ask in normal prose; a short explicit owner agreement and the parallel button path resolve the same authenticated confirmation outside the agent loop.

## Boundary

The current typed result is authoritative: never claim a task changed while it remains a proposal, and never simulate an unwired confirmation path. A second task operation in the same turn fails deterministically. Confirmation or rejection, when required, is an authenticated application command outside the agent tool loop; transports never submit owner id, digest, or authoritative proposal payload.
