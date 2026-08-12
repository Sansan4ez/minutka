# /bin/capture-idea

## Purpose

Save a classified owner idea through the typed ingestion boundary after retrieve-before-write found no clear match or the owner chose a separate record.

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
- Compare with visible `/proc/records` first; do not call this tool while awaiting a clear duplicate choice.
- If a duplicate choice is unanswered or ambiguous, preserving the item by creating a separate idea is required.
- A URL is accepted as ordinary summary/source text. Preserve useful surrounding text and stated processing intent in the one captured idea.
- A URL does not authorize or perform fetch, download, snapshot, metadata extraction, artifact creation, context-document creation, or an external action.
- The tool does not expose a store, SQL, shell, arbitrary filesystem access, browser, or web-fetch capability.
