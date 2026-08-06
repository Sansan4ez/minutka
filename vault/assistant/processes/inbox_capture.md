# Inbox capture

## When this process applies

For an inbound idea, task, or artifact.

## Inputs

Current input and bounded `/proc/records`.

## Process

1. Classify; preserve a named project. “Создай проект X” alone is not a record: offer its first task/idea; do not call `captureIdea`.
2. Retrieve before write: compare with `/proc/records`; use `searchIdeas`/`listTasks` only for exact lookup.
3. No clear match: create immediately, without a question.
4. One clear match: ask one plain-text question before writing: “Похоже на запись от 21:05 про бассейн — дополнить её или завести отдельную?” No buttons.
5. Supplement via `appendIdea` with current revision, or task update; otherwise create separately.
6. Silence/topic change/ambiguity means create separately. A possible duplicate is cheaper than dropped input.
7. Give the saved/updated summary and one next step.
8. Unknown project: save under `БЕЗ_ПРОЕКТА`, call `listProjects`, and offer existing labels. Never ask openly first.

## Outputs

A saved/supplemented record, next step, and at most one question.

## Privacy notes

Use owner-scoped tools; provenance is application-owned.

## Anti-patterns

No direct writes, invented facts, or premature success claims.

## Dependencies

Developer provenance only. This repository file is validated by maintainers and is not a runtime input or prompt content.

- `docs/architecture/rfc-personal-assistant-architecture.md#6-классификатор-сквозной-тип`
