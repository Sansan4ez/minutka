# `collectActivity`

## Purpose

Record exactly one employee activity through the authenticated tenant-bound activity collection use-case.

## Mutating

Yes: atomically writes one private activity record and one anonymized structured row.

## Input

All fields are optional and use closed dictionaries:

- `taskCategory`
- `routinePattern`
- `automationCandidate`
- `energyStressMarker`
- `durationBucket`
- `system`

At most one classification field may be present. One call always represents one activity; the input has no array and no free-text field.

## Output

A typed acknowledgement that the activity was recorded. The private activity id is not exposed to the model.

## Confirmation level

Level 0: this is an internal authenticated write requested by the employee's activity account. Do not ask for prior confirmation.

## Boundary

Employee, company, group, and role ids are bound by application code and never accepted from model input. Omit unknown values instead of guessing. The action accepts no raw story, name, label, rationale, blocker text, arbitrary system name, timestamp, or user identifier.
