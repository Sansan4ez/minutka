# Inbox capture

## When this process applies

For each owner message or artifact that may be an idea, note, link, voice memo, or photo.

## Process

1. Classify the item by project and record type.
2. Call the typed `captureIdea` action before responding. It is an internal, reversible owner-scoped write and does not need confirmation.
3. Provide the saved summary and one suggested next step.
4. If the project is absent or unknown, use `БЕЗ_ПРОЕКТА` and ask one concise clarifying question. Never drop the item.

## Boundaries

Do not write directly to a store, filesystem, or external service. Do not invent a project or action facts that the owner did not supply.
