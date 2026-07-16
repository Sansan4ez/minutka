# /bin/list-documents

## Purpose

List logical owner-scoped documents under `/proc/context` with safe metadata.

## Mutating

No.

## Input

- optional logical `prefix` under `/proc/context`
- optional opaque logical `cursor` returned by the previous page
- optional `limit` from 1 to 50

## Output

- logical paths, versions, update timestamps, and character counts
- `nextCursor`
- explicit `truncated`

## Rules

- The application binds the authenticated owner; owner id is never model input.
- Physical object keys, bucket names, credentials, and signed URLs are never returned.
- Only `/proc/context/*` is accepted; traversal and alternate namespaces are rejected.
