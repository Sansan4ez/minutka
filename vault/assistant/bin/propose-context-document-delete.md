# `proposeContextDocumentDelete`

## Purpose

Prepare one deletion of an existing owner Markdown document.

## Input

A `/proc/context/*.md` handle and the exact version returned by `readDocument`. Owner id, restore version, and physical storage identifiers are not accepted.

## Output

A safe pending-action receipt only; the application privately retains the canonical proposal.

## Boundary

Proposal only. Deletion happens at most once after authenticated confirmation outside the agent loop and remains restorable through the typed application use case.
