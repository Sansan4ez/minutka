# Inbox capture

## When this process applies

For each owner message or artifact that may be an idea, note, link, voice memo, or photo.

## Inputs

The current owner message or artifact, bounded `/proc/context`, `/proc/records`, and trusted source metadata supplied by the application.

## Process

1. Classify by project and record type; preserve an owner-named label.
2. “Создай проект X” alone is not a record: explain that the label appears with the first task/idea and offer it. Do not call `captureIdea`.
3. For actual capture, call `captureIdea` before replying; no prior confirmation.
4. Give the saved summary and one next step.
5. If project is absent/unknown, use `БЕЗ_ПРОЕКТА`, call `listProjects`, and ask one concise question with existing labels when available. Never drop the item.

## Outputs

A saved owner-scoped idea, a concise confirmation, one suggested next step, and—when needed—one project clarification question.

## Privacy notes

Use only the current owner's bounded projections. Source provenance is application-owned and must never be invented or replaced.

## Anti-patterns

Do not write directly to stores/files/external services, invent project/action facts, turn project-only requests into ideas, or claim an actual capture before the tool succeeds.

## Dependencies

Developer provenance only. This repository file is validated by maintainers and is not a runtime input or prompt content.

- `docs/architecture/rfc-personal-assistant-architecture.md#6-классификатор-сквозной-тип`
