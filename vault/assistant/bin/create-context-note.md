# `createContextNote`

## Purpose

Create a new owner Markdown note only after an explicit request to save or add it.

## Input

Title, Markdown content, and an optional destination from the closed context-section catalog. Owner id, physical key, bucket, and arbitrary top-level namespace are not accepted.

## Output

A safe receipt with outcome, `/proc/context/*` path, and version/current version. No physical storage identifier is exposed.

## Confirmation level

Level 0: this is a reversible internal owner-scoped write. Do not ask for prior confirmation after the owner explicitly requests the save; report the created logical path and the available restoration path in words.

## Boundary

This write goes through `ContextDocumentService`, not filesystem access. It never promotes an artifact automatically and never overwrites an existing note.
