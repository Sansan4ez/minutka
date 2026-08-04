# `proposeIdeaToTask`

## Purpose

Prepare one idempotent conversion of an existing owner idea into a task while the application preserves provenance privately.

## Inputs

An existing idea id. There is no owner id, task id, confirmation payload, or provenance field in model input.

## Output

`not_found`, `already_converted` with only the existing task id, or `needs_confirmation` with only the safe pending-action receipt. In every branch, the model and serialized tool trace do not receive owner id, canonical proposal, generated task provenance, origin idea id, digest, or creation timestamp; `AssistantService` captures canonical data privately.

## Confirmation level

Level 0: `idea_to_task` is a reversible internal owner-scoped write. When the application returns an applied result, report it in normal prose and name the worded undo path; do not ask for prior confirmation.

## Boundary

The current typed result is authoritative: if it is still `needs_confirmation`, no task mutation has occurred and the idea remains unchanged until the authenticated application command executes the stored canonical proposal outside the agent tool loop. Never simulate an unwired level-0 path. A second task operation in the same turn fails deterministically.
