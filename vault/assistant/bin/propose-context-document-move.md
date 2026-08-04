# `proposeContextDocumentMove`

## Purpose

Prepare one rename or move of an existing owner Markdown document.

## Input

Source and destination `/proc/context/*.md` handles plus the exact version returned by `readDocument`. Destination must remain inside an allow-listed context section.

## Output

A safe pending-action receipt only; the owner-visible card is rendered by the transport.

## Confirmation level

Level 1: moving a document has ambiguous consequences but is recoverable. Ask once in normal prose and explicitly say the owner can answer «да» or press the button; both paths resolve the same authenticated confirmation outside the agent loop.

## Boundary

No source or destination changes before authenticated confirmation. Trusted control-plane and arbitrary namespaces cannot be targeted. The transport, not the model, deterministically resolves short verbal confirmation.
