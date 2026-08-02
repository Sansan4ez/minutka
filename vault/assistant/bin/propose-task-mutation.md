# `proposeTaskMutation`

## Purpose

Prepare one typed proposal per assistant turn to create, update, complete, or cancel an owner task.

## Inputs

Task content or a current task id plus expected revision. The tool does not accept an owner id, a generated task id, `originIdeaId`, or terminal status through a generic update.

## Output

The model and serialized tool trace receive only the safe pending-action receipt: opaque confirmation id, action kind, bounded human-readable summary, and expiry. The canonical pending record is captured privately by `AssistantService` and is not part of the tool output. Do not quote or render the receipt, task id, confirmation id, or confirmation instructions in the assistant response; the application owns the owner-visible confirmation card.

## Boundary

Proposal only: this tool never mutates `TaskStore`. A second task proposal in the same turn fails deterministically. Confirmation or rejection is an authenticated application command outside the agent tool loop; transports never submit owner id, digest, or authoritative proposal payload.
