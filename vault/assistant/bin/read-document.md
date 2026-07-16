# /bin/read-document

## Purpose

Read a bounded range or an exact Markdown section from one owner document under `/proc/context`.

## Mutating

No.

## Input

- logical document `path` under `/proc/context`
- optional non-negative character `offset`
- optional exact Markdown heading `section`
- optional `maxCharacters` from 1 to 8000

## Output

- logical path and safe version metadata
- `found` and `sectionFound`
- bounded content, current offset, next offset
- explicit `truncated`

## Rules

- The application binds the authenticated owner; owner id is never model input.
- Missing documents return `found: false` without leaking another owner's existence.
- Physical storage identifiers and credentials are never returned.
