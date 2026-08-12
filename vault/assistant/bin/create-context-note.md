# `createContextNote`

## Purpose

Create a new owner Markdown note only after an explicit request to save or add it and a retrieve-before-write check found no clear thematic document or the owner chose a separate note.

## Input

Title, Markdown content, and an optional destination from the closed context-section catalog. Owner id, physical key, bucket, and arbitrary top-level namespace are not accepted.

## Output

A safe receipt with outcome, `/proc/context/*` path, and version/current version. No physical storage identifier is exposed.

## Confirmation level

Level 0: this is a reversible internal owner-scoped write. Do not ask for prior confirmation after the owner explicitly requests the save and the retrieve-before-write choice is resolved; report the created logical path, its neighboring section/document, and the available restoration path in words.

## Boundary

This write goes through `ContextDocumentService`, not filesystem access. Before calling it, inspect the `/proc/context` tree, read the chosen section's exact-case `INDEX.md` when present, and run 2–3 short `searchDocuments` variants. If one thematic document is clearly close, show its logical path and offer `proposeContextDocumentUpdate` instead. Prefer that document's allow-listed section for a separate note; use `00_inbox` only when no section is evident. It never promotes an artifact automatically, creates arbitrary top-level namespaces, or overwrites an existing note.
