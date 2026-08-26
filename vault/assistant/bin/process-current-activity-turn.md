# `processCurrentActivityTurn`

## Purpose

Process factual work from the current authenticated employee turn through one bounded activity transaction.

## Mutating

Potentially. `record` may append a bounded activity batch. `repair` may correct one exact recent row or supersede one confirmed duplicate. `no_write`, clarification, and pre-write failures change nothing.

## Input

Input is only `{ mode: "record" | "repair" }`:

- `record` — explicitly completed or in-progress work, including repeated real work;
- `repair` — explicit correction/clarification of a recent activity or an explicitly confirmed duplicate.

The model cannot provide raw text, employee or tenant identity, duration evidence, facets, candidates, handles, revisions, timestamps, or source ids. The application binds all of them to the current request.

## Output

A compact typed result:

- `no_write`;
- `needs_clarification` with a bounded reason;
- `completed` with collected count or corrected/superseded revision;
- `partial` with saved count and bounded code;
- `failed` with phase and bounded code;
- `outcome_unknown`.

The main agent forms the employee-facing answer only after this result and never claims success before it.

## Confirmation level

Level 0: factual collection and explicit local correction are authenticated internal writes.

## Boundary

The transaction service owns the constrained extraction call, bounded recent read for repair, validation, exact mutation path, and persistence semantics. Plans, intentions, future tasks, not-started work, weekly/cycle reads, and scheduled invitations without a fresh employee account do not call this tool.
