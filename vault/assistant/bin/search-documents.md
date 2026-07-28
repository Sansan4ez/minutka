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

- logical paths with explicit `matchedBy: path | content`
- `snippet: null` for path matches; bounded snippets of at most 500 characters plus ellipses for content matches
- safe version metadata
- explicit `truncated`, `readBudgetExhausted`, `scanBudgetExhausted`, `documentTooLarge`, and a narrowing hint

## Rules

- Search is limited to the authenticated owner's personal context namespace.
- Matching is case-insensitive literal substring search over paths and contents, not a regular expression.
- Sorted logical path metadata is checked first. A path match is returned once without reading the body, even when the same document content would also match.
- Results never include physical object keys, bucket names, credentials, or signed URLs.
- Path matches consume neither the request-scoped 48k Unicode-character output budget nor the 2 MiB physical scan budget. Content snippets share the output budget with document reads.
- Only documents without a path match proceed to content scanning. Search reserves each such candidate's exact metadata size before reading its body and never reads an object over 256 KiB.
- `documentTooLarge`, `scanBudgetExhausted`, or `readBudgetExhausted` together with `truncated=true` means content search was incomplete; later metadata path matches may still be returned without body reads.
- Tool audit stores logical paths, sizes, offsets, truncation reasons, and outcome; never query or document text.
