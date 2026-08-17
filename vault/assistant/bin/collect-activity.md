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

`taskCategory` may be combined with one obstacle field (`routinePattern`, `automationCandidate`, or `energyStressMarker`) in the same call. The obstacle never requires a separate call. Send at most one obstacle field. The call is not rejected when several arrive — only the first of that order is recorded — because a rejected call loses the whole activity. One call always represents one activity; the input has no array and no free-text field.

## Output

A typed acknowledgement that the activity was recorded. The private activity id is not exposed to the model.

## Confirmation level

Level 0: this is an internal authenticated write requested by the employee's activity account. Do not ask for prior confirmation.

## Boundary

Employee, company, group, and role ids are bound by application code and never accepted from model input. Omit unknown values instead of guessing. The action accepts no raw story, name, label, rationale, blocker text, arbitrary system name, timestamp, or user identifier.
