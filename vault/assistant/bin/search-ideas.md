# searchIdeas

## Purpose

Search the authenticated owner's active ideas by id, project, or summary and return a bounded deterministic candidate list with current revisions.

## Boundary

This is read-only. Owner identity is bound by `AssistantService`; deleted records are excluded. If more than one candidate matches a natural-language reference, the assistant must ask the owner to choose.
