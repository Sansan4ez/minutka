# Private retrospective evaluation

Internal R7 analysis, not a client report or proof of causal effect. No live sends, publication, migrations or group enabling.

```bash
npx tsx src/runtime/retrospective-evaluation.ts --help
npx tsx src/runtime/retrospective-evaluation.ts \
  --company COMPANY --group GROUP \
  --from 2026-08-26T00:00:00.000Z --to 2026-09-09T23:59:59.000Z \
  --input /private/research/evaluation-input.json \
  --output /private/research/evaluation-output.json
```

The input is a private JSON bundle `{corpus, artifacts, measurements?}`. `corpus` is the existing typed research-corpus v2 JSON export; `artifacts` contains private retrospective-recommendations/v1 artifacts read through the recommendation use-case. No incompatible research export change. Keep all inputs outside Git. Output must be outside the repository, is created exclusively with mode 0600, and never overwrites an existing file. The CLI does not print payloads or write raw audit data.

`measurements` follows `retrospectiveMeasurementsSchema` in `src/application/retrospective-evaluation.ts`: exact scope, `touches`, `observations`, `changes`, and `omissions`. Touch receipts include timestamp, stable touch ID, subject, process, method version, eligibility, delivery outcome, explicit reply message IDs, invitation/acceptance and evidence refs. Populate from scheduler/delivery records and operator receipts, not text-template matching. A generated question or synthetic prompt is not delivery. Unknown-origin messages are not employee replies. Response numerator counts replied delivered touches, not messages; denominator is delivered eligible touches. Acceptance requires an explicit employee message. UTC seven-day bins are anchored at `--from`; participant-days use UTC dates, explicitly not wall-clock burden.

Observations preserve evidence refs and reasons for attempt/result, skips, factual errors, duplicate time, short-answer resolution, complaints/disable, employee self-reported minutes and operator minutes. Do not infer these from silence or elapsed conversation time. Missing receipts are explicitly unavailable rather than inferred zeroes. Count attempts/results once per subject/episode. `changes` records old/new version, timestamp, reason and refs; disclose uncovered sources in `omissions`.

Episode quality is reconstructed from canonical snapshot/status events through the period end; only episodes touched during the period are cases. Follow-ups do not become independent cases. Four-stage coverage lists evidence-backed non-agent statements and denominators. Selected steps, attempts and observed results remain distinct. Traces preserve usage/latency/failure separately from employee and operator time. Feedback is existing message feedback; final usefulness/burden feedback not captured there must be disclosed as missing or supplied as evidence receipts, never invented.

The application service accepts an optional versioned `RetrospectiveRubricGenerator`. It receives the scoped evidence and returns per-candidate operation, claims, feasible first test, human control, unknowns, refs and disputed cases. Its optional same-case comparison records initial/full first tests, new evidence refs and explanation. Refs must resolve to supplied messages/events/statements. This is an agent judgment, not independent validation or causal A/B. The offline CLI intentionally has no LLM adapter: it marks semantic rubric and paired comparison unavailable, and exposes structural checks only. Operators must review every final candidate and disputed judgment against the source evidence; the evaluation never grants checked/publish status. Candidate/artifact revisions, status, review and generator/method versions remain visible.

Focused verification: `npx vitest run specs/executable/minutka/SPEC-RETRO-EVALUATION.spec.ts` (network/LLM-free). Live-cycle collection and interpretation remain separate operator tasks.
