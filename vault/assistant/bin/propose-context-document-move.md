# `proposeContextDocumentMove`

## Purpose

Prepare one rename or move of an existing owner Markdown document.

## Input

Source and destination `/proc/context/*.md` handles plus the exact version returned by `readDocument`. Destination must remain inside an allow-listed context section.

## Output

A safe pending-action receipt only; the owner-visible card is rendered by the transport.

## Confirmation level

Level 1: moving a document has ambiguous consequences but is recoverable. Ask in normal prose; a short explicit owner agreement and the parallel button path resolve the same authenticated confirmation outside the agent loop.

## Boundary

No source or destination changes before authenticated confirmation. Trusted control-plane and arbitrary namespaces cannot be targeted. Never simulate an unwired verbal-confirmation path.
