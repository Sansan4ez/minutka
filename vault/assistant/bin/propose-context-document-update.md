# `proposeContextDocumentUpdate`

## Purpose

Prepare one update of an existing owner Markdown document.

## Input

A `/proc/context/*.md` handle, the exact version returned by `readDocument`, and exactly one full replacement or unique search/replacement patch. Owner id and physical storage identifiers are not accepted.

## Output

A safe pending-action receipt only; the application privately retains the bounded diff preview and canonical proposal.

## Boundary

Proposal only. The document is unchanged until authenticated confirmation outside the agent loop. A stale-version conflict must not be retried as an overwrite.
