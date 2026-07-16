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
- explicit `truncated`

## Rules

- Search is limited to the authenticated owner's personal context namespace.
- Results never include physical object keys, bucket names, credentials, or signed URLs.
- Tool audit stores only operation, result count, truncation, and outcome; never query or content.
