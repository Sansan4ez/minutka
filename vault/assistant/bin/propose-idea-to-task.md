# `proposeIdeaToTask`

## Purpose

Prepare one idempotent conversion of an existing owner idea into a task while the application preserves provenance privately.

## Inputs

An existing idea id. There is no owner id, task id, confirmation payload, or provenance field in model input.

## Output

`not_found`, `already_converted` with only the existing task id, or `needs_confirmation` with only the safe pending-action receipt. In every branch, the model and serialized tool trace do not receive owner id, canonical proposal, generated task provenance, origin idea id, digest, or creation timestamp; `AssistantService` captures canonical data privately.

## Boundary

Proposal only: no task mutation occurs until an authenticated owner confirmation command executes the stored canonical proposal outside the agent tool loop. The idea remains unchanged. A second task proposal in the same turn fails deterministically.
