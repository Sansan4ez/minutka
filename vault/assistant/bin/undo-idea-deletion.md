# undoIdeaDeletion

## Purpose

Restore one exact deleted owner idea, or the owner's most recent deleted idea, during the bounded undo window.

## Boundary

Owner identity is bound by `AssistantService`. The operation is typed and idempotent, cannot restore another owner's record, and returns only record id/result metadata to the model.
