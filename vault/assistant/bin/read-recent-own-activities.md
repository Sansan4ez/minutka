# `readRecentOwnActivities`

## Purpose

Return a small deterministic list of the authenticated employee's active own activities from the last 72 hours so an explicit correction, clarification, or duplicate confirmation can select an exact target for the next typed mutation step.

## Mutating

No. This action changes nothing.

## Input

No model-visible fields. Employee, company, group, time window, and limit are bound and enforced by application code.

## Output

At most five activities, newest first. Each item contains only:

- opaque `handle` and positive `revision`;
- closed `taskCategory`, `routinePattern`, `automationCandidate`, `energyStressMarker`, `durationBucket`, and `system` facets when present;
- `activityDate` and `recordedAt`.

The result contains no employee, subject, company, group, role, or message ids and no raw employee wording.

## Use rule

Call only when the employee explicitly corrects or clarifies an earlier activity, or makes an unambiguous reference to a recent one. Never call before ordinary `collectActivities` writes and never use it as semantic deduplication: repeating the same kind of work can be a separate factual episode. If several candidates fit, ask one short clarifying question. If no candidate fits, change nothing; this read does not authorize a mutation and does not turn the new account into a duplicate.

## Boundary

The store and application service both enforce active status, the authenticated employee/company/group tuple, the 72-hour window, stable newest-first order, and limit five. `correctRecentActivity` and `supersedeRecentActivity` accept only returned opaque handles/revisions; no mutation exists in this read action.
