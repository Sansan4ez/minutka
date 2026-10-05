import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { z } from "zod";
import type { WorkRetrospectiveEpisode, RetrospectiveScope } from "../domain/work-retrospective.js";
import type { ArtifactStore } from "./artifact-store.js";
import type { ArtifactContentStore } from "./artifact-content-store.js";
import type { ResearchEvidenceScope, RoutineEvidenceRead, ResearchEvidenceReadService } from "./research-evidence-read.js";
import type { WorkRetrospectiveUseCases } from "./work-retrospective-store.js";
import { durationBucketHours } from "./company-reporting.js";
import { sanitizeResearchText } from "./research-trace-store.js";
import { systemClock, type Clock } from "./runtime-primitives.js";

const text = z.string().trim().min(1);
export const recommendationEvidenceRefSchema = z.strictObject({
  companyId: text, groupId: text, subjectKey: text, threadId: text,
  episodeId: text, revision: z.number().int().nonnegative(),
  statementId: text, quote: text,
});
const claim = z.strictObject({ text, refs: z.array(recommendationEvidenceRefSchema).min(1) });
export const recommendationProposalSchema = z.strictObject({
  operation: claim, opportunity: claim,
  known: z.strictObject({ input: claim.nullable(), output: claim.nullable(), method: claim.nullable(), criterion: claim.nullable() }),
  unknowns: z.array(text), change: text.nullable(), humanControl: text.nullable(),
  firstTest: text.nullable(), expectedSign: text.nullable(), stopCondition: text.nullable(),
  facts: z.array(claim), hypotheses: z.array(text), technicalQuestions: z.array(text),
  disposition: z.enum(["recommendation", "deep_dive"]),
});
export type RecommendationProposal = z.infer<typeof recommendationProposalSchema>;
export type RecommendationEvidenceRef = z.infer<typeof recommendationEvidenceRefSchema>;
export type RecommendationEpisode = Omit<WorkRetrospectiveEpisode, "employeeId">;
export type RecommendationInput = { scope: ResearchEvidenceScope; episodes: RecommendationEpisode[]; evidence: RoutineEvidenceRead };
export type RecommendationGenerator = {
  version: string;
  generate(input: RecommendationInput): Promise<RecommendationProposal[]>;
};
export type RecommendationResearchRead = { read(scope: ResearchEvidenceScope): Promise<RecommendationInput> };

/** Discovery is trusted application input, never model-selected identities. All reads go through typed use-cases. */
export function createRecommendationResearchRead(deps: {
  participants(scope: ResearchEvidenceScope): Promise<RetrospectiveScope[]>;
  episodes: Pick<WorkRetrospectiveUseCases, "readEpisodes">;
  evidence: Pick<ResearchEvidenceReadService, "listRoutineEvidence">;
}): RecommendationResearchRead {
  return { async read(scope) {
    const episodes: RecommendationEpisode[] = [];
    for (const participant of await deps.participants(scope)) {
      if (!sameScope(scope, participant)) throw new Error("cross_scope_participant");
      const result = await deps.episodes.readEpisodes({ scope: participant, limit: 100 });
      if (result.status !== "applied" && result.status !== "replayed") throw new Error("episode_read_failed");
      // The bounded episode API has no pagination: do not silently present a truncated corpus as complete.
      if (result.value.length === 100) throw new Error("episode_read_limit");
      for (const { employeeId: _privateIdentity, ...episode } of result.value) episodes.push(episode);
    }
    return { scope, episodes, evidence: await deps.evidence.listRoutineEvidence(scope) };
  } };
}

export const recommendationArtifactSchemaVersion = "retrospective-recommendations/v1" as const;
export type RecommendationCandidate = RecommendationProposal & {
  candidateId: string; status: "draft" | "checked" | "rejected" | "stale";
  /** checked means explicit operator review, not independent LLM expertise. */
  review?: { operatorId: string; reviewedAt: string };
};
const candidateSchema = recommendationProposalSchema.extend({
  candidateId: text, status: z.enum(["draft", "checked", "rejected", "stale"]),
  review: z.strictObject({ operatorId: text, reviewedAt: z.iso.datetime() }).optional(),
}).refine((candidate) => candidate.status !== "checked" || !!candidate.review, "Checked requires operator review");
export const recommendationArtifactSchema = z.strictObject({
  schemaVersion: z.literal(recommendationArtifactSchemaVersion), artifactId: text,
  version: z.number().int().positive(), previousArtifactId: text.optional(),
  scope: z.strictObject({ companyId: text, groupId: text }), createdAt: z.iso.datetime(),
  versions: z.strictObject({ generator: text, methods: z.array(text) }),
  candidates: z.array(candidateSchema), contributors: z.array(text),
  episodeRefs: z.array(z.strictObject({ subjectKey: text, threadId: text, episodeId: text, revision: z.number().int().nonnegative() })),
  coverage: z.strictObject({ episodes: z.number().int().nonnegative(), activities: z.number().int().nonnegative(), observedHours: z.number().nonnegative() }),
});
export type RecommendationArtifact = {
  schemaVersion: typeof recommendationArtifactSchemaVersion;
  artifactId: string; version: number; previousArtifactId?: string;
  scope: ResearchEvidenceScope; createdAt: string;
  versions: { generator: string; methods: string[] };
  candidates: RecommendationCandidate[];
  contributors: string[];
  episodeRefs: Array<{ subjectKey: string; threadId: string; episodeId: string; revision: number }>;
  coverage: { episodes: number; activities: number; observedHours: number };
};
export type RecommendationOutcome<T> =
  | { status: "applied"; value: T }
  | { status: "not_found" | "forbidden" | "stale" }
  | { status: "failed"; code: "validation_error" | "generation_error" | "storage_error" };

/** Private research owner namespace: never an employee or company delivery account. */
export function recommendationArtifactOwner(scope: ResearchEvidenceScope): string {
  return `research-recommendations-${createHash("sha256").update(JSON.stringify([scope.companyId, scope.groupId])).digest("hex")}`;
}

export class RetrospectiveRecommendationService {
  constructor(private readonly deps: {
    research: RecommendationResearchRead; generator: RecommendationGenerator;
    artifacts: ArtifactStore; contents: ArtifactContentStore;
    /** Resolve an existing content-store signed URL; injectable for offline specs. No URL is persisted. */
    loadContent(url: string): Promise<string>;
    clock?: Clock; id?: () => string;
  }) {}

  async build(scope: ResearchEvidenceScope): Promise<RecommendationOutcome<RecommendationArtifact>> {
    if (!validScope(scope)) return { status: "failed", code: "validation_error" };
    try {
      const input = normalizeInput(scope, await this.deps.research.read(scope));
      const proposals = z.array(recommendationProposalSchema).parse(await this.deps.generator.generate(input));
      const candidates = proposals.map((proposal): RecommendationCandidate => {
        const valid = supported(proposal, input);
        const sufficient = complete(proposal);
        return { ...proposal, candidateId: this.id(), status: valid && sufficient ? "draft" : "rejected",
          ...(!valid || !sufficient ? { disposition: "deep_dive" as const, change: null, humanControl: null, firstTest: null, expectedSign: null, stopCondition: null } : {}) };
      });
      const activities = new Map(input.episodes.flatMap((episode) => episode.activityRefs.map((ref) => {
        const activity = input.evidence.activities.find((a) => a.subjectKey === episode.subjectKey && a.activityId === ref.activityId && (a.revision ?? 1) === ref.revision && (!a.status || a.status === "active"));
        return [ref.activityId, activity] as const;
      })).filter((entry) => entry[1] !== undefined));
      return { status: "applied", value: {
        schemaVersion: recommendationArtifactSchemaVersion, artifactId: this.id(), version: 1, scope: { ...scope }, createdAt: this.now(),
        versions: { generator: this.deps.generator.version, methods: [...new Set(input.episodes.map((e) => e.methodVersion))].sort() }, candidates,
        contributors: [...new Set([...input.episodes.map((e) => e.subjectKey), ...input.evidence.messages.map((m) => m.subjectKey), ...input.evidence.activities.map((a) => a.subjectKey)])].sort(),
        episodeRefs: input.episodes.map(({ subjectKey, threadId, episodeId, revision }) => ({ subjectKey, threadId, episodeId, revision })),
        coverage: { episodes: input.episodes.length, activities: activities.size, observedHours: [...activities.values()].reduce((sum, a) => sum + (a?.durationBucket ? durationBucketHours[a.durationBucket] : 0), 0) },
      } };
    } catch { return { status: "failed", code: "generation_error" }; }
  }

  /** Re-read current scoped evidence before explicit operator acceptance. Produces a new immutable version. */
  async check(scope: ResearchEvidenceScope, artifact: RecommendationArtifact, review: { operatorId: string; decisions: Record<string, "checked" | "rejected"> }): Promise<RecommendationOutcome<RecommendationArtifact>> {
    if (!sameScope(scope, artifact.scope)) return { status: "forbidden" };
    if (!review.operatorId.trim()) return { status: "failed", code: "validation_error" };
    try {
      const input = normalizeInput(scope, await this.deps.research.read(scope));
      const stale = artifact.episodeRefs.some((ref) => !input.episodes.some((e) => e.subjectKey === ref.subjectKey && e.threadId === ref.threadId && e.episodeId === ref.episodeId && e.revision === ref.revision));
      const candidates = artifact.candidates.map((candidate): RecommendationCandidate => {
        const status = stale || !supported(candidate, input) ? "stale" : !complete(candidate) ? "rejected" : review.decisions[candidate.candidateId] ?? "draft";
        const { review: _oldReview, ...proposal } = candidate;
        return { ...proposal, status, ...(status === "checked" || status === "rejected" ? { review: { operatorId: review.operatorId, reviewedAt: this.now() } } : {}) };
      });
      return { status: "applied", value: { ...artifact, artifactId: this.id(), previousArtifactId: artifact.artifactId, version: artifact.version + 1, createdAt: this.now(), candidates } };
    } catch { return { status: "failed", code: "validation_error" }; }
  }

  /** Recompute is a new generation/version; review never carries across changed evidence. */
  async recompute(scope: ResearchEvidenceScope, previous: RecommendationArtifact): Promise<RecommendationOutcome<RecommendationArtifact>> {
    if (!sameScope(scope, previous.scope)) return { status: "forbidden" };
    const result = await this.build(scope);
    return result.status === "applied" ? { status: "applied", value: { ...result.value, version: previous.version + 1, previousArtifactId: previous.artifactId } } : result;
  }

  async save(scope: ResearchEvidenceScope, artifact: RecommendationArtifact): Promise<RecommendationOutcome<{ artifactId: string }>> {
    if (!sameScope(scope, artifact.scope)) return { status: "forbidden" };
    try {
      recommendationArtifactSchema.parse(artifact);
      const input = normalizeInput(scope, await this.deps.research.read(scope));
      if (artifact.candidates.some((candidate) => candidate.status === "checked" && (!supported(candidate, input) || !complete(candidate)))
        || artifact.episodeRefs.some((ref) => !input.episodes.some((e) => e.subjectKey === ref.subjectKey && e.threadId === ref.threadId && e.episodeId === ref.episodeId && e.revision === ref.revision))) return { status: "stale" };
      // Every model-visible contributor is retained even if the model did not cite them.
      const contributors = [...new Set([...artifact.contributors, ...input.episodes.map((e) => e.subjectKey), ...input.evidence.messages.map((m) => m.subjectKey), ...input.evidence.activities.map((a) => a.subjectKey)])].sort();
      const body = Buffer.from(sanitizeResearchText(JSON.stringify({ ...artifact, contributors })));
      await this.deps.artifacts.save({ ownerId: recommendationArtifactOwner(scope), artifactId: artifact.artifactId,
        originalFileName: `recommendations-v${artifact.version}.json`, declaredMediaType: "application/json",
        source: { kind: "generated", generatorId: recommendationArtifactSchemaVersion, deliveryKey: artifact.artifactId },
        body: { size: body.length, openStream: () => Readable.from([body]) } });
      return { status: "applied", value: { artifactId: artifact.artifactId } };
    } catch { return { status: "failed", code: "storage_error" }; }
  }

  async read(scope: ResearchEvidenceScope, artifactId: string): Promise<RecommendationOutcome<RecommendationArtifact>> {
    try {
      const owner = recommendationArtifactOwner(scope);
      const ref = await this.deps.artifacts.get(owner, artifactId);
      if (!ref || ref.status !== "active" || ref.source.kind !== "generated" || ref.source.generatorId !== recommendationArtifactSchemaVersion) return { status: "not_found" };
      const url = await this.deps.contents.presignGet(owner, ref.contentDigest, 60);
      const artifact = recommendationArtifactSchema.parse(JSON.parse(await this.deps.loadContent(url)));
      if (!sameScope(scope, artifact.scope)) return { status: "forbidden" };
      if (artifact.schemaVersion !== recommendationArtifactSchemaVersion || artifact.artifactId !== artifactId) return { status: "failed", code: "validation_error" };
      const input = normalizeInput(scope, await this.deps.research.read(scope));
      const stale = artifact.episodeRefs.some(ref => !input.episodes.some(e => e.subjectKey === ref.subjectKey && e.threadId === ref.threadId && e.episodeId === ref.episodeId && e.revision === ref.revision));
      return { status: "applied", value: { ...artifact, candidates: artifact.candidates.map(candidate => {
        if (candidate.status !== "checked" || (!stale && supported(candidate, input))) return candidate;
        const { review: _review, ...rest } = candidate;
        return { ...rest, status: "stale" as const };
      }) } };
    } catch { return { status: "failed", code: "storage_error" }; }
  }
  /** Latest active own version; malformed durable data blocks rather than falling back to older approval. */
  async readLatest(scope: ResearchEvidenceScope): Promise<RecommendationOutcome<RecommendationArtifact>> {
    try {
      const refs = await this.deps.artifacts.list(recommendationArtifactOwner(scope), { status: "active" });
      const values: RecommendationArtifact[] = [];
      for (const ref of refs) {
        if (ref.source.kind !== "generated" || ref.source.generatorId !== recommendationArtifactSchemaVersion) continue;
        const result = await this.read(scope, ref.artifactId);
        if (result.status !== "applied") return result;
        values.push(result.value);
      }
      values.sort((a, b) => b.version - a.version || b.createdAt.localeCompare(a.createdAt) || b.artifactId.localeCompare(a.artifactId));
      return values[0] ? { status: "applied", value: values[0] } : { status: "not_found" };
    } catch { return { status: "failed", code: "storage_error" }; }
  }
  private id(): string { return (this.deps.id ?? randomUUID)(); }
  private now(): string { return (this.deps.clock ?? systemClock).now(); }
}
function validScope(scope: ResearchEvidenceScope): boolean { return !!scope.companyId.trim() && !!scope.groupId.trim(); }
function sameScope(a: ResearchEvidenceScope, b: ResearchEvidenceScope): boolean { return a.companyId === b.companyId && a.groupId === b.groupId; }
function normalizeInput(scope: ResearchEvidenceScope, input: RecommendationInput): RecommendationInput {
  if (!sameScope(scope, input.scope) || input.episodes.some((e) => !sameScope(scope, e)) || input.evidence.activities.some((a) => !sameScope(scope, a))) throw new Error("cross_scope_evidence");
  const episodes = new Map<string, RecommendationEpisode>();
  for (const episode of input.episodes) {
    const key = JSON.stringify([episode.subjectKey, episode.threadId, episode.episodeId]);
    if ((episodes.get(key)?.revision ?? -1) < episode.revision) episodes.set(key, episode);
  }
  // Sanitization happens before model invocation as well as persistence.
  return JSON.parse(sanitizeResearchText(JSON.stringify({ ...input, episodes: [...episodes.values()] }))) as RecommendationInput;
}
/** Read-only publish validation: no generation, review mutation or new version. */
export function currentCheckedRecommendations(scope: ResearchEvidenceScope, artifact: RecommendationArtifact, current: RecommendationInput): RecommendationCandidate[] {
  recommendationArtifactSchema.parse(artifact);
  if (!sameScope(scope, artifact.scope)) throw new Error("cross_scope_artifact");
  const input = normalizeInput(scope, current);
  if (artifact.episodeRefs.some((ref) => !input.episodes.some((e) => e.subjectKey === ref.subjectKey && e.threadId === ref.threadId && e.episodeId === ref.episodeId && e.revision === ref.revision))) return [];
  return artifact.candidates.filter((candidate) => candidate.status === "checked" && !!candidate.review && complete(candidate) && supported(candidate, input));
}

function complete(p: RecommendationProposal): boolean {
  return p.disposition === "recommendation" && p.facts.length > 0 && !!p.known.method && !!p.known.criterion && !!p.change && !!p.humanControl && !!p.firstTest && !!p.expectedSign && !!p.stopCondition;
}
function supported(p: RecommendationProposal, input: RecommendationInput): boolean {
  const claims = [p.operation, p.opportunity, ...Object.values(p.known).filter((c) => c !== null), ...p.facts];
  return claims.every((claim) => claim.refs.length > 0 && claim.refs.every((ref) => {
    // Factual fields are extractive. Analytical paraphrases belong in hypotheses.
    if (claim.text !== ref.quote) return false;
    if (!sameScope(input.scope, ref)) return false;
    const episode = input.episodes.find((e) => e.subjectKey === ref.subjectKey && e.threadId === ref.threadId && e.episodeId === ref.episodeId && e.revision === ref.revision);
    const statement = episode && Object.values(episode.statements).flat().find((s) => s.statementId === ref.statementId && s.kind === "employee_fact" && s.text === ref.quote);
    return !!statement && statement.sourceRefs.length > 0 && statement.sourceRefs.every((source) => source.type === "message"
      ? !!input.evidence.messages.find((m) => m.subjectKey === ref.subjectKey && m.messageId === source.messageId && m.userText.includes(ref.quote))
      : !!input.evidence.activities.find((a) => a.subjectKey === ref.subjectKey && a.activityId === source.activityId && (a.revision ?? 1) === source.revision && (!a.status || a.status === "active")));
  }));
}
