# `collectActivities`

## Purpose

Record all explicitly named completed or in-progress employee activities through the authenticated, tenant-bound use-case.

## Mutating

Yes: sequentially writes one canonical private activity record per array item. A storage failure returns how many earlier items were saved.

## Input

Input is `{ activities: [...] }`. Send one item per fact. A call accepts at most 50 items; continue in input order in the next call rather than dropping facts. Items use only optional closed-dictionary fields:

- `taskCategory`
- `routinePattern`
- `automationCandidate`
- `energyStressMarker`
- `durationBucket`
- `system`

In one item, combine `taskCategory` with every explicit facet: `routinePattern`, `automationCandidate`, and `energyStressMarker` may coexist. Omit unknowns; never infer emotion or split facets into rows. One item is one factual activity, no free text.

## Output

A typed `completed`, `failed`, or `partial` status with `savedCount`; ids and errors stay private. For `failed` or `partial`, report `savedCount`, say the rest was not recorded, and do not retry it automatically. The application reconciles an unknown outcome by exact-id read-back without changing activity meaning.

## Confirmation level

Level 0: this is an internal authenticated write requested by the employee's activity account. Do not ask for prior confirmation.

## Boundary

Employee, company, group, and role ids are bound by application code and never accepted from model input. Omit unknown values instead of guessing. The action accepts no raw story, name, label, rationale, blocker text, arbitrary system name, timestamp, or user identifier.
