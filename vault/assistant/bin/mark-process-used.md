# `markProcessUsed`

## Purpose

Record request-scoped diagnostic evidence that the agent actually applied an active allow-listed process.

## Inputs

A closed product process id accepted by the tool schema. The active diagnostic ids are `morning_planning`, `midday_adjustment`, `personal_context_review`, `consent_and_privacy`, `evening_reflection`, and `weekly_summary`; retired `morning_activity_collection` and disabled `day_focus` are rejected.

## Output

A typed acknowledgement containing the same process id.

## Boundary

Diagnostic only. The marker has no store, external action, or business mutation capability and never authorizes another tool. Unknown or disabled ids fail closed at schema validation.
