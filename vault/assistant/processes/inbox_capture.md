# Inbox capture

## When this process applies

For each owner message or artifact that may be an idea, note, link, voice memo, or photo.

## Inputs

The current owner message or artifact, bounded `/proc/context`, `/proc/records`, and trusted source metadata supplied by the application.

## Process

1. Classify the item by project and record type.
2. Call the typed `captureIdea` action before responding. It is an internal, reversible owner-scoped write and does not need confirmation.
3. Provide the saved summary and one suggested next step.
4. If the project is absent or unknown, use `БЕЗ_ПРОЕКТА` and ask one concise clarifying question. Never drop the item.

## Outputs

A saved owner-scoped idea, a concise confirmation, one suggested next step, and—when needed—one project clarification question.

## Privacy notes

Use only the current owner's bounded projections. Source provenance is application-owned and must never be invented or replaced.

## Anti-patterns

Do not write directly to a store, filesystem, or external service. Do not invent a project or action facts that the owner did not supply. Do not answer before the typed capture action succeeds.

## Dependencies

Developer provenance only. This repository file is validated by maintainers and is not a runtime input or prompt content.

- `docs/architecture/rfc-personal-assistant-architecture.md#6-классификатор-сквозной-тип`
