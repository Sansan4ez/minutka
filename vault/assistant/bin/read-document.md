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
- bounded content, current offset, next offset, and `totalCharacters` for the document or selected section
- explicit `truncated`, request-scoped `readBudgetExhausted`, and a narrowing hint when the turn budget is exhausted

## Rules

- The application binds the authenticated owner; owner id is never model input.
- Missing documents return `found: false` without leaking another owner's existence.
- Physical storage identifiers and credentials are never returned.
- Returned content shares the request-scoped 48k Unicode-character turn budget with search snippets; boundary reads are clamped instead of failing.
