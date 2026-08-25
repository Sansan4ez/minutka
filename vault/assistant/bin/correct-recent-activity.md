# `correctRecentActivity`

## Purpose

Correct the closed facets of exactly one recent activity selected by `readRecentOwnActivities`, without inserting another factual activity row.

## Mutating

Yes. Level 0 local repair. The original evidence and every revision remain in research provenance.

## Input

- exact opaque `handle` and positive `expectedRevision` returned by the bounded read;
- `mode`: `patch` changes supplied facets only; `replace` clears omitted facets and replaces the closed facet set;
- `correction`: closed activity facets only, with no free text or identity fields.

Employee, company, group, and the correction source message are bound by the application.

## Use rule

Use only for an explicit employee correction or clarification and only after one candidate is unambiguous. Several candidates require one short question. A stale revision or missing/cross-scope handle changes nothing; never guess a new revision or fall back to `collectActivities`.

## Result

Returns the same opaque handle and its advanced revision. Repeating the exact request from the same source message is idempotent.
