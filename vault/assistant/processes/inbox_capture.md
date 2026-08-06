# Inbox capture

## When this process applies

For an inbound idea, task, artifact, or URL.

## Inputs

Current input, provenance, and `/proc/records`.

## Process

1. Classify; preserve a named project. “Создай проект X” alone is not a record: offer its first task/idea; do not call `captureIdea`.
2. Retrieve before write: compare with `/proc/records`; use `searchIdeas`/`listTasks` only for exact lookup.
3. Treat a URL in chat as ordinary text. Keep the URL, useful surrounding text, and stated intent together in one summary; source remains chat text provenance.
4. No clear match: create immediately. One clear match: ask one plain-text question before writing: “Похоже на запись от 21:05 про бассейн — дополнить её или завести отдельную?” Supplement via `appendIdea`/task update; otherwise create separately. Silence/ambiguity means create separately. A possible duplicate is cheaper than dropped input.
5. URL without processing intent: call `captureIdea`, confirm the save, then ask exactly once: “Что сделать со ссылкой?” Do not invent a task.
6. URL with intent: retain it in summary/next step. Use only a supplied typed capability; if page reading is unavailable, say so and never claim page contents were read.
7. Give the saved/updated summary and one next step. Unknown project: save under `БЕЗ_ПРОЕКТА`, call `listProjects`, and offer labels. Never ask openly first.

## Outputs

One saved/supplemented record per URL message, confirmation, next step, and at most one post-capture intent question.

## Privacy notes

Owner-scoped tools only; provenance is application-owned. A chat URL does not create an `ArtifactReference`, context document, download snapshot, or external action.

## Anti-patterns

No direct writes, invented facts, automatic URL fetch/download/snapshot, metadata extraction, malware scanning, web research, or claims that the page was read.

## Dependencies

Developer provenance only. This repository file is validated by maintainers and is not a runtime input or prompt content.

- `docs/architecture/rfc-personal-assistant-architecture.md#6-классификатор-сквозной-тип`
