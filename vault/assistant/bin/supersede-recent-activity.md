# `supersedeRecentActivity`

## Purpose

Record explicit confirmation that one recent canonical activity row duplicates or is replaced by another recent row of the same employee and tenant.

## Mutating

Yes. Level 0 local repair. No row, message, trace, or revision is deleted.

## Input

- duplicate `handle` and `expectedRevision`;
- active `replacementHandle` and `replacementExpectedRevision` to keep in current projections.

All handles must come from one bounded `readRecentOwnActivities` result. Identity and source-message provenance are application-bound.

## Use rule

Use only after explicit duplicate/replacement confirmation and an unambiguous pair. Never infer duplicates, perform semantic deduplication, or automatically merge facets. A stale revision, same handle twice, or cross-owner/cross-group handle changes nothing.

## Result

The duplicate remains in research export with `superseded` status, link to the replacement, and revision history, but weekly/cycle summaries and company report count only active rows. Repeating the exact request from the same source message is idempotent.
