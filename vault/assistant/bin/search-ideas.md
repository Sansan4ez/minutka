# searchIdeas

## Purpose

Search the authenticated owner's active ideas by id, project, or summary and return a bounded deterministic candidate list with current revisions. Use it to find an existing record before creating a similar idea and to resolve deletion references.

## Boundary

This is read-only. Owner identity is bound by `AssistantService`; deleted records are excluded. Compare with the already visible `/proc/records` first; call this tool when a candidate needs exact lookup or the visible window is insufficient. If more than one candidate matches, show a short list rather than guessing.
