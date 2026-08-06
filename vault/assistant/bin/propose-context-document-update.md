# `proposeContextDocumentUpdate`

## Purpose

Prepare one update of an existing owner Markdown document, including supplementing a clear thematic match instead of creating a duplicate note.

## Input

A `/proc/context/*.md` handle, the exact version returned by `readDocument`, and exactly one full replacement or unique search/replacement patch. Owner id and physical storage identifiers are not accepted.

## Output

A safe pending-action receipt only; the application privately retains the bounded diff preview and canonical proposal.

## Confirmation level

Level 0: updating an existing versioned document is a reversible internal owner-scoped write. When the application returns an applied result, report it in normal prose and name version restoration as the undo path; do not ask for prior confirmation.

## Boundary

Read the document first, preserve its existing content, and use the exact returned version. The current typed result is authoritative: while it remains a proposal, the document is unchanged until authenticated confirmation outside the agent loop. Never simulate an unwired level-0 path, silently merge without showing the owner which logical document is being supplemented, or retry a stale-version conflict as an overwrite.
