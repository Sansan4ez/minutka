# Day focus

## When this process applies

When the owner asks what to focus on today or now, requests a short plan, or wants to reprioritize current goals, ideas, and tasks.

## Inputs

The current owner request, bounded `/proc/context` for goals and known projects, bounded `/proc/records` for active tasks and ideas, and the owner-scoped `listTasks` capability when the projected task details are insufficient. Calendar data is optional and is not required for this process.

## Process

1. Call `markProcessUsed({ id: "day_focus" })` once when you apply this process. This records request diagnostics only and grants no capability or authority.
2. Read the available owner goals, project context, active tasks, and ideas. Work internal-first; do not assume calendar access or invent meetings, availability, deadlines, or commitments.
3. If the inputs are empty or insufficient, say what is missing instead of manufacturing priorities.
4. Rank candidates by explicit owner-goal alignment, overdue or near-term commitments, work already in progress, and practical leverage. An overdue item does not silently override an explicit owner goal: state the conflict when they point in different directions.
5. Select at most three priorities. Mark conflicting deadlines, unclear goal alignment, and `БЕЗ_ПРОЕКТА` or otherwise unknown projects explicitly.
6. Give exactly one concrete next action that can be started now. Make it an observable action, not a vague intention.
7. Keep planning read-only unless the owner explicitly asks to create or change a task. `create`, `update`, and `complete` return an applied level-0 result: state the saved change and the worded undo path without ids. A `cancel` result remains a safe pending action; execution or rejection happens later through an authenticated owner command outside the agent tool loop. Never claim a pending cancellation changed the task.

## Outputs

A concise focus response containing zero to three ordered priorities, exactly one concrete next action, and only the caveats needed for missing data, unknown projects, deadline conflicts, or conflict with owner goals.

## Privacy notes

Use only the current owner's bounded projections and owner-scoped typed capabilities. Do not expose raw private context unnecessarily in the answer, and do not infer facts about another owner.

## Anti-patterns

Do not add a planning agent or pre-flight router. Do not require calendar integration, produce more than three priorities, hide uncertainty, invent project ownership or deadlines, or report a task mutation from a proposal or an unconfirmed outcome.

## Dependencies

Developer provenance only. This repository file is validated by maintainers and is not a runtime input or prompt content.

- `docs/architecture/rfc-personal-assistant-architecture.md#8-реестр-навыков`
- `docs/architecture/rfc-personal-assistant-architecture.md#13-фазовый-план`
- `docs/architecture/rfc-agent-led-routing.md#2-решение`
