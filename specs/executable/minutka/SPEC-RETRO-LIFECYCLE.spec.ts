import { describe, expect, it } from "vitest";
import { createInMemoryRetrospectiveLifecycle } from "../../../src/application/in-memory-retrospective-lifecycle.js";
import { sanitizeRetrospectiveMetadata } from "../../../src/application/retrospective-event-store.js";
import { createRetrospectiveStore } from "../../../src/application/in-memory-work-retrospective-store.js";
import { RetrospectiveRecommendationService, currentCheckedRecommendations, type RecommendationArtifact, type RecommendationInput } from "../../../src/application/retrospective-recommendations.js";
import { createInMemoryArtifactStore } from "../../../src/application/in-memory-artifact-store.js";
import { createInMemoryArtifactContentStore } from "../../../src/application/in-memory-artifact-content-store.js";
import type { WorkRetrospectiveEpisode, WorkRetrospectiveEvent } from "../../../src/domain/work-retrospective.js";
const now = "2026-08-26T12:00:00.000Z";
const scope = { companyId: "c1", groupId: "g1" };
const episode = (subjectKey = "s1", groupId = "g1", companyId = "c1"): WorkRetrospectiveEpisode => ({ companyId, groupId, subjectKey, employeeId: subjectKey, threadId: "thread", episodeId: subjectKey, revision: 0, methodVersion: "v1", period: { start: now, end: "2026-09-09T12:00:00.000Z" }, messageRefs: [{ messageId: "m1" }], activityRefs: [{ activityId: "a1", revision: 1 }], statements: { actions: [{ statementId: "fact", text: "Prepared report", kind: "employee_fact", sourceRefs: [{ type: "activity", activityId: "a1", revision: 1 }] }], value: [], future: [], indicators: [] }, status: "active", questionBudget: { localDate: "2026-08-26", dailyDelivered: 0 } });
const artifact = (contributors: string[], groupId = "g1", companyId = "c1"): RecommendationArtifact => ({ schemaVersion: "retrospective-recommendations/v1", artifactId: contributors.join("-") + groupId, version: 1, scope: { companyId, groupId }, createdAt: now, versions: { generator: "stub", methods: ["v1"] }, contributors, episodeRefs: [], candidates: [], coverage: { episodes: 0, activities: 0, observedHours: 0 } });
const state = () => ({ artifacts: [artifact(["s1", "s2"]), artifact(["s1", "s2"]), artifact(["s2"]), artifact(["s3"], "g2"), artifact(["s4"], "g1", "c2")], episodes: [episode(), episode("s2"), episode("s3", "g2"), episode("s4", "g1", "c2")], policies: ["c1", "c2"].map(companyId => ({ companyId, groupId: "g1", enabled: true, methodVersion: "v1", period: episode().period })), messages: ["s1", "s2", "s3", "s4"].map(subjectKey => ({ subjectKey, metadata: { version: 1 as const } })) });
describe("retrospective lifecycle", () => {
  it("SPEC-RETRO-LIFECYCLE-01 deletes all dependent versions including uncited contributors", async () => {
    const data = state(); const lifecycle = createInMemoryRetrospectiveLifecycle(data);
    expect((await lifecycle.preview({ ...scope, subjectKey: "s1" })).recommendationVersions).toBe(2);
    await lifecycle.purge({ ...scope, subjectKey: "s1" });
    expect(data.artifacts.map(a => a.contributors)).toEqual([["s2"], ["s3"], ["s4"]]);
    expect(data.episodes.map(e => e.subjectKey)).toEqual(["s2", "s3", "s4"]);
    expect(data.messages.map(m => m.subjectKey)).not.toContain("s1");
  });
  it("SPEC-RETRO-LIFECYCLE-02 company purge removes policy/events/candidates, preserving c2", async () => {
    const data = state(); await createInMemoryRetrospectiveLifecycle(data).purge({ companyId: "c1" });
    expect(data.artifacts).toHaveLength(1); expect(data.artifacts[0]!.scope.companyId).toBe("c2");
    expect(data.policies.map(p => p.companyId)).toEqual(["c2"]);
    expect(data.messages.map(m => m.subjectKey)).toEqual(["s4"]);
  });
  it("SPEC-RETRO-LIFECYCLE-03 corrected activity is stale on read before publish; recompute drops review", async () => {
    const input: RecommendationInput = { scope, episodes: [episode()], evidence: { messages: [], activities: [{ ...scope, subjectKey: "s1", activityId: "a1", roleId: "role", activityDate: "2026-08-26", recordedAt: now, revision: 1, status: "active" }] } };
    const ref = { ...scope, subjectKey: "s1", threadId: "thread", episodeId: "s1", revision: 0, statementId: "fact", quote: "Prepared report" };
    const claim = { text: ref.quote, refs: [ref] };
    const candidate = { candidateId: "candidate", status: "checked" as const, review: { operatorId: "operator", reviewedAt: now }, operation: claim, opportunity: claim, known: { input: claim, output: claim, method: claim, criterion: claim }, unknowns: [], change: "test", humanControl: "check", firstTest: "try", expectedSign: "match", stopCondition: "error", facts: [claim], hypotheses: [], technicalQuestions: [], disposition: "recommendation" as const };
    const previous = { ...artifact(["s1"]), candidates: [candidate] };
    const { candidateId: _id, status: _status, review: _review, ...proposal } = candidate;
    const contents = createInMemoryArtifactContentStore({ now: () => now });
    const artifacts = createInMemoryArtifactStore({ contentStore: contents, clock: { now: () => now }, limits: { maximumBytes: 100000, timeoutMs: 1000 } });
    const service = new RetrospectiveRecommendationService({ research: { read: async () => input }, generator: { version: "stub", generate: async () => [proposal] }, contents, artifacts, loadContent: async () => JSON.stringify(previous), clock: { now: () => now } });
    expect((await service.save(scope, previous)).status).toBe("applied");
    input.evidence.activities[0]!.revision = 2;
    const read = await service.read(scope, previous.artifactId);
    expect(read.status === "applied" && read.value.candidates[0]!.status).toBe("stale");
    expect(currentCheckedRecommendations(scope, previous, input)).toEqual([]);
    const rebuilt = await service.recompute(scope, previous);
    expect(rebuilt.status === "applied" && rebuilt.value.version).toBe(2);
    expect(rebuilt.status === "applied" && rebuilt.value.candidates[0]!.review).toBeUndefined();
  });
  it("SPEC-RETRO-LIFECYCLE-04 rebuild from canonical ledger preserves consent and budget without duplicate facts", async () => {
    const e = episode(); const event = (revision: number, action: WorkRetrospectiveEvent["action"]): WorkRetrospectiveEvent => ({ ...e, eventId: `event${revision}`, episodeId: e.episodeId, sourceMessageId: "m1", ordinal: revision, expectedRevision: revision, timestamp: now, version: 1, action });
    const events = [event(0, { type: "episode_selected", episode: e }), event(1, { type: "follow_up_consent_changed", consent: { granted: true, sourceRef: { messageId: "m1" } } }), event(2, { type: "response_delivery", responseMessageId: "r", questionId: "q", status: "delivered", localDate: "2026-08-26" })];
    let projection: WorkRetrospectiveEpisode[] = [];
    const store = createRetrospectiveStore({ readEvents: async () => structuredClone(events), appendTurn: async () => {}, appendDeliveryEvents: async () => {}, getRecentTurns: async () => [], getTurnsBeforeRecent: async () => [], getTurnByMessageId: async () => undefined }, { replace: async (_scope, episodes) => { projection = episodes; } });
    const request = { scope: e, episodeId: e.episodeId }; const first = await store.rebuild(request); projection = [];
    expect(await store.rebuild(request)).toEqual(first); expect(projection[0]!.statements.actions).toHaveLength(1);
    expect(projection[0]!.followUpConsent?.granted).toBe(true); expect(projection[0]!.questionBudget.dailyDelivered).toBe(1);
  });
  it("SPEC-RETRO-LIFECYCLE-05 statement sanitization removes secret before projection/export without raw audit", () => {
    const value = { statement: "api_key=sk-test-secret-1234567890", audit: { outcome: "sanitized" } };
    const sanitized = sanitizeRetrospectiveMetadata(value);
    expect(JSON.stringify(sanitized)).not.toContain("sk-test-secret-1234567890");
    expect(sanitized.audit).toEqual({ outcome: "sanitized" });
  });
});
