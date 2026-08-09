# appendIdea

## Purpose

Append owner-provided details to one exact existing idea instead of creating a duplicate record.

## Mutating

Yes: updates the existing owner-scoped idea summary and renews its activity timestamp.

## Input

- exact idea id
- current revision from `/proc/records` or `searchIdeas`
- owner-provided text to append

## Output

- `applied` with the updated idea
- `conflict` with current safe idea fields
- `not_found`

## Confirmation level

Level 0: immediate internal write without an undo path. Use only after the owner chooses to supplement the existing idea. Do not ask for a button confirmation.

## Rules

- Owner identity is bound by `AssistantService`, never accepted from model input.
- Preserve the existing summary and append the new text; do not silently replace it.
- On `conflict` or `not_found`, say nothing changed and offer to search again.
