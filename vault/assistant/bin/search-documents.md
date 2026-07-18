# /bin/search-documents

## Purpose

Search logical owner-scoped document paths and contents under `/proc/context`.

## Mutating

No.

## Input

- query of at least two characters
- optional logical `prefix` under `/proc/context`
- optional `limit` from 1 to 20

## Output

- logical paths and bounded snippets of at most 500 characters plus ellipses
- safe version metadata
- explicit `truncated`, request-scoped `readBudgetExhausted`, and a narrowing hint when the turn budget is exhausted

## Rules

- Search is limited to the authenticated owner's personal context namespace.
- Matching is case-insensitive literal substring search over paths and contents, not a regular expression.
- Results never include physical object keys, bucket names, credentials, or signed URLs.
- Returned snippets share the request-scoped 48k Unicode-character turn budget with document reads; metadata listing does not consume it.
- Tool audit stores logical paths, sizes, offsets, truncation reasons, and outcome; never query or document text.
