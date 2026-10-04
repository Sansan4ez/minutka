# Linked factual activity transactions

Implementation for `mnt-hf3h.4`; runtime/group-policy wiring belongs to `mnt-hf3h.6`.

The application opts in by passing `ActivityTransactionTrustedRequest.retrospectiveScope`
only after resolving the group policy. Inject `retrospective.readEpisodes` and
`linkedTransactions` into `ActivityTransactionService`; use
`createPostgresLinkedActivityTransactionStore(pool)` for durable runtime and the
in-memory adapter for executable specifications. Apply migration 0083 first.
The model-facing tool still accepts only `mode`; it cannot supply scope or target.

Only one active, same-day, in-period pending episode supplies question/target context,
bounded to 6000 characters. The question is reference context, not evidence. A
`linked` decision performs one patch correction followed by a batch of new facts.
The existing correction use-case enforces owner/company/group, revision and the
72-hour window even when the target is outside the five recent candidates.
Duration references cannot be shared between correction and collection.

Reservations are keyed by full scope, source message and operation ordinal:
0 reserves generation/the aggregate result; 1 reserves correction; 2 reserves
collection when present. Reserve before effects, complete with each typed outcome.
Retries return the saved aggregate without generation or repeated writes. Partial
collection and unknown outcomes are terminal for automatic replay, not instructions
to retry. An interrupted reservation without an outcome returns `outcome_unknown`;
do not clear it or rerun the message blindly. Inspect canonical activity revisions
and source links before any explicit operator reconciliation. Participant/thread
purge cascades to reservations. This does not change legacy record idempotency.

The request-bound tool returns separate compact outcomes, not extraction context,
activity IDs, target refs or corpus. Runtime wiring must retain extraction metadata
for research traces outside the model-facing result.

Verification:

```bash
npx vitest run specs/executable/minutka/SPEC-RETRO-TRANSACTION.spec.ts
# Separate test DB only:
set -a; . ./.env; set +a
npm run specs:persistence
```
