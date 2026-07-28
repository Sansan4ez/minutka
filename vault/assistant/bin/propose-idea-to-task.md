# `proposeIdeaToTask`

## Purpose

Prepare an idempotent conversion of an existing owner idea into a task while preserving typed `originIdeaId` provenance.

## Inputs

An existing idea id. There is no owner id, task id, or provenance field in model input.

## Output

`not_found`, `already_converted`, or an owner-bound pending task confirmation.

## Boundary

Proposal only: no task mutation occurs until the exact pending proposal is explicitly confirmed through `confirmTaskMutation`. The idea remains unchanged.
