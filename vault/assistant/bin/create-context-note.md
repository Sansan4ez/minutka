# `createContextNote`

## Purpose

Create a new owner Markdown note only after an explicit request to save or add it.

## Input

Title, Markdown content, and an optional destination from the closed context-section catalog. Owner id, physical key, bucket, and arbitrary top-level namespace are not accepted.

## Output

A safe receipt with outcome, `/proc/context/*` path, and version/current version. No physical storage identifier is exposed.

## Boundary

This is a reversible internal write through `ContextDocumentService`, not filesystem access. It never promotes an artifact automatically and never overwrites an existing note.
