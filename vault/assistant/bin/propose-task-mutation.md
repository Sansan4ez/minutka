# `proposeTaskMutation`

## Purpose

Prepare a typed proposal to create, update, complete, or cancel an owner task.

## Inputs

Task content or a current task id plus expected revision. The tool does not accept an owner id, a generated task id, `originIdeaId`, or terminal status through a generic update.

## Output

An owner-bound pending confirmation containing the normalized proposal, confirmation id, digest, and expiry.

## Boundary

Proposal only: this tool never mutates `TaskStore`. The assistant must present the proposal and wait for explicit owner confirmation before calling `confirmTaskMutation` with the exact returned proposal.
