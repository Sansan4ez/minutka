# `markProcessUsed`

## Purpose

Record request-scoped diagnostic evidence that the agent actually applied an allow-listed inline process.

## Inputs

A closed product process id accepted by the tool schema. The active process ids are `morning_activity_collection`, `consent_and_privacy`, `day_focus`, and `evening_reflection`.

## Output

A typed acknowledgement containing the same process id.

## Boundary

Diagnostic only. The marker itself has no store, external action, or business mutation capability and never authorizes another tool. Unknown ids fail closed at schema validation.
