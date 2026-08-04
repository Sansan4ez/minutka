# /bin/capture-idea

## Purpose

Save a classified owner idea through the typed ingestion boundary.

## Mutating

Yes: creates an owner-scoped idea record.

## Input

- project
- record type
- summary
- suggested next step
- project-clarification flag

## Output

- idea id
- project
- owner-facing response
- project-clarification flag

## Confirmation level

Level 0: this is a reversible internal owner-scoped write. Do not ask for prior confirmation; after a successful capture, report the result and name the available deletion/undo path in words.

## Rules

- Owner and source provenance are bound by `AssistantService`, never accepted from model input.
- The tool does not expose a store, SQL, shell, or arbitrary filesystem access.
