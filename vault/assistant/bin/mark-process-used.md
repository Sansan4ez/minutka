# `markProcessUsed`

## Purpose

Record request-scoped diagnostic evidence that the agent actually applied an allow-listed inline read-only process.

## Inputs

A closed product process id accepted by the tool schema. The active read-only process ids are `day_focus` and `evening_reflection`.

## Output

A typed acknowledgement containing the same process id.

## Boundary

Diagnostic only. The tool has no store, external action, or business mutation capability and never authorizes another tool. Unknown ids fail closed at schema validation.
