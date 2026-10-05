# Retrospective recommendation artifact v1

Producer: `mnt-hf3h.9`. Consumers: `mnt-hf3h.10` (client projection/publish),
`mnt-hf3h.11` (purge/sanitize/invalidation/recompute), `mnt-hf3h.12` (evaluation).
This is a private research contract, not a client DTO or authorization credential.

## Typed boundary

`src/application/retrospective-recommendations.ts` exports:

- `createRecommendationResearchRead`: trusted participant/thread discovery +
  `WorkRetrospectiveUseCases.readEpisodes` + `ResearchEvidenceReadService.listRoutineEvidence`.
  Employee IDs are removed before generation. Reads enforce company/group.
  The existing episode API caps reads at 100; a saturated read is rejected rather
  than silently describing a truncated period as complete.
- `RecommendationGenerator`: version and structured `generate` port.
  `createMastraRecommendationGenerator(agent)` supplies the adapter; no runtime
  enabling or public tool registration is introduced.
- `RetrospectiveRecommendationService.build/check/save/read` with typed outcomes.
  `check` takes explicit trusted operator ID and per-candidate decisions, rereads
  current evidence, and returns a new immutable artifact version. It is not
  independent methodological expertise.
- `recommendationProposalSchema`, `recommendationEvidenceRefSchema`,
  `recommendationArtifactSchema`, `RecommendationArtifact`,
  `recommendationArtifactSchemaVersion = retrospective-recommendations/v1`.

Factual fields are extractive claims with exact statement quotes and refs
(company/group/subject/thread/episode/revision/statementId). Claims only cite
`employee_fact` with current canonical message/activity sources. Analytical
paraphrases belong in hypotheses. Proposed change, human control, first test,
expected sign, stop condition and technical questions are separate from facts.
Unknown input/output/method/criterion is nullable and explicitly described.
Insufficient support yields rejected/deep_dive, never a generic quick-win promise.

Statuses: draft, checked, rejected, stale. Only explicit operator decisions can
produce checked, and only with current supporting evidence and a complete test.
Save rereads evidence and refuses stale versions; checked artifacts require review
metadata. Consumers must revalidate current provenance before publication.
Existing report thresholds and confidence rules remain unchanged.

## Storage and provenance

Artifacts use existing `ArtifactStore`/`ArtifactContentStore` and generated source
`generatorId = retrospective-recommendations/v1`. Each version has a distinct
artifact ID, version number, optional previousArtifactId, creation time, generator
and method versions, candidates and coverage. Owner namespace comes from
`recommendationArtifactOwner(company/group)` and is **not** an employee/company
transport account. No client delivery or public presigned URL is stored.

Read uses short-lived content-store presigning plus injected `loadContent`; offline
specs resolve the in-memory content URL. Private research owners are supported by migration `0084_research_artifact_owners.sql`.
Ordinary employee owners retain existence validation and cascading artifact deletion. Restart verification recreates the service while retaining its stores.

`contributors` includes **all model-visible subjects**, not just cited subjects.
`episodeRefs` includes all contributing episode identities/revisions. Purge must
invalidate/delete the entire artifact if any contributor is affected; then
sanitize/recompute from current typed research reads. Lifecycle deletion enumerates **all** generated references, including inactive history,
and removes every physical CAS object version before deleting its indexes. Consumers should enumerate
active generated references in the scoped private owner namespace, read their
manifest, and preserve immutable versions rather than overwrite an artifact.

Coverage counts unique `(subjectKey, threadId, episodeId)` snapshots at latest
revision and unique current activity IDs; clarification messages add neither
independent episodes nor hours. Bucket hours are observed estimates, not savings
or a full time balance. Existing company report aggregation/publish is untouched.

## Lifecycle

`RetrospectiveLifecycle` is operator-only and scoped to company, group or subject.
Employee deletion and scope purge runtimes compose the PostgreSQL/MinIO adapter;
canonical message metadata and episode projections cascade with participants.
Preview and results include derived counts. No real purge is run by tests.
Policy is currently injected in-memory, not persisted: its adapter supplies scoped
`purge`; PostgreSQL policy count is zero until a durable policy store exists.

Typed recommendation reads revalidate checked candidates against current sources
and expose stale status after correction/supersession. Publish also revalidates.
`recompute` generates a new version/previousArtifactId without inheriting review.
Episode replay uses structural equality (JSONB ordering is not semantic), preserves
consent and delivered budgets, and sanitizes statement/question text with the
existing research-secret filter. Research export includes sanitized canonical
metadata as an optional additive v2 field; no raw text is copied to audit.

## Offline verification

`npx vitest run specs/executable/minutka/SPEC-RETRO-CANDIDATE.spec.ts`

Includes acceptance IDs 01–05, trusted research reads, source/revision checks,
operator review and restart round-trip of both draft and reviewed versions.
