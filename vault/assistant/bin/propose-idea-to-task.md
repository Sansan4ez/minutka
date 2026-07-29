# `proposeIdeaToTask`

## Purpose

Prepare one idempotent conversion of an existing owner idea into a task while preserving typed `originIdeaId` provenance.

## Inputs

An existing idea id. There is no owner id, task id, confirmation payload, or provenance field in model input.

## Output

`not_found`, `already_converted`, or a canonical pending task proposal captured by `AssistantService`; chat exposes only the safe pending-action DTO.

## Boundary

Proposal only: no task mutation occurs until an authenticated owner confirmation command executes the stored canonical proposal outside the agent tool loop. The idea remains unchanged. A second task proposal in the same turn fails deterministically.
