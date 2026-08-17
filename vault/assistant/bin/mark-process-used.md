# `markProcessUsed`

## Purpose

Record request-scoped diagnostic evidence that the agent actually applied an active allow-listed process.

## Inputs

A closed product process id accepted by the tool schema. The active diagnostic ids are `morning_activity_collection`, `consent_and_privacy`, and `evening_reflection`; `day_focus` is rejected.

## Output

A typed acknowledgement containing the same process id.

## Boundary

Diagnostic only. The marker has no store, external action, or business mutation capability and never authorizes another tool. Unknown or disabled ids fail closed at schema validation.
