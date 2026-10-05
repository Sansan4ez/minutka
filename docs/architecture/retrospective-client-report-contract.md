# Retrospective client report v3

Producer: `mnt-hf3h.10`; private candidate contract:
[retrospective-recommendation-contract.md](retrospective-recommendation-contract.md).

`CompanyReportingService` accepts an optional third constructor argument with
`policies`, `readLatest(scope)` and `research`. The trusted composition selects the
latest durable candidate version using `RetrospectiveRecommendationService.read`;
it must not pin an older reviewed version after a replacement exists. No generator
is invoked by reporting or publication. Existing production composition is unchanged
and remains group-off; supplying these ports does not enable any group by default.
The reporting opt-in is scoped and persists after the live policy period ends so
operators can prepare the end-of-cycle artifact.

Enabled groups receive `minutka-client-report.v3`, existing factual aggregates,
`recommendationVersion` (an opaque artifact digest), and `recommendations` containing
only aggregate routine name, change, firstTest, expectedSign, limitations,
humanControl and stopCondition. Quotes, refs, reviews, identities and personal
obligations are not projected. All evidence is reread before each projection;
checked status, explicit review, source revisions and episode revisions are validated.
Recommendations must connect to an eligible named aggregate routine through actual
activity refs, with at least three observations and two contributors. Existing
energy-signal and coverage policies remain intact. Unsupported or stale candidates
are excluded; uncovered routines appear in deepDive, never generic quick wins.
Disabled groups retain the v2 DTO without extra properties.

New client texts receive deterministic high-severity content lint. The CLI's optional
`preflight-llm` command also includes these texts in its existing content-check step;
**build and publish themselves never call an LLM**. Findings hash the entire client
DTO including the candidate-version digest. Candidate replacement or changing
supported recommendations invalidates earlier findings and decisions.

`publishClientReport` requires `operatorDecision: "publish"` for v3 in addition to
current findings and resolution of every high finding. V3 decisions/publication
record reviewer `operator`; methodologist decisions cannot clear a v3 high finding.
CLI: `company-report publish ... --operator-publish` is the explicit operator gate.
JSON build/export and publish outputs include the new DTO fields without a separate
rendering layer. No production report is published by implementing this contract.

Offline verification: `npx vitest run specs/executable/minutka/SPEC-RETRO-PUBLISH.spec.ts`.
