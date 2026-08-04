# `proposeIdeaToTask`

## Purpose

Prepare one idempotent conversion of an existing owner idea into a task while the application preserves provenance privately.

## Inputs

An existing idea id. There is no owner id, task id, confirmation payload, or provenance field in model input.

## Output

`not_found`, `already_converted` with only the existing task id, or `status: applied` with the safe task view and `undoAvailable: true`. In every branch, the model and serialized tool trace do not receive owner id, canonical proposal, generated provenance, origin idea id, digest, or confirmation timestamp; `AssistantService` captures canonical data privately. For `applied`, report the result in one sentence and add “Скажи «отмени», если не то”, without ids.

## Confirmation level

Level 0: `idea_to_task` is a reversible internal owner-scoped write. When the application returns an applied result, report it in normal prose and name the worded undo path; do not ask for prior confirmation.

## Boundary

The current typed result is authoritative: claim conversion only for `status: applied`. The stored canonical proposal remains private even though the application immediately executes its authenticated decision path. `undoTaskMutation` removes the created task and restores the idea's previous status from server-held state. A second task operation in the same turn fails deterministically.
