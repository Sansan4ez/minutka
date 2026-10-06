import { describe, expect, it } from "vitest";
import { CompanyReportingService, type CompanyReportSnapshot } from "../../../src/application/company-reporting.js";
import { type RecommendationArtifact, type RecommendationInput } from "../../../src/application/retrospective-recommendations.js";
import { ClientReportPublishingService } from "../../../src/application/client-report-publishing.js";
import { hashClientReport, type ReportPreflightFindingsFile } from "../../../src/application/report-preflight.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createDeterministicIdGenerator } from "../../../src/application/runtime-primitives.js";
const scope = { companyId: "company_a", groupId: "group_a" };
const now = "2026-08-26T12:00:00.000Z";
export function setup(enabled = true) {
  const subjects = ["private_subject_a", "private_subject_b"];
  const activities = Array.from({ length: 6 }, (_, i) => ({ ...scope, subjectKey: subjects[i % 2]!, activityId: `a${i}`, roleId: "role_a", activityDate: `2026-08-${24 + Math.floor(i / 2)}`, recordedAt: now, durationBucket: "15_30m" as const, routineLabel: "Перенос полей", routineId: "transfer", revision: 1, status: "active" as const }));
  const input: RecommendationInput = { scope, evidence: { activities, messages: subjects.map((subjectKey, i) => ({ subjectKey, messageId: `m${i}`, userText: "private quote", agentResponse: "private obligation", timestamp: now })) }, episodes: subjects.map((subjectKey, i) => ({ ...scope, subjectKey, threadId: "private_thread", episodeId: `e${i}`, revision: 1, methodVersion: "v1", period: { start: now, end: now }, status: "completed", messageRefs: [{ messageId: `m${i}` }], activityRefs: [{ activityId: `a${i}`, revision: 1 }], statements: { actions: [{ statementId: "s", text: "private quote", kind: "employee_fact", sourceRefs: [{ type: "message", messageId: `m${i}` }, { type: "activity", activityId: `a${i}`, revision: 1 }] }], value: [], future: [], indicators: [] }, questionBudget: { localDate: "2026-08-26", dailyDelivered: 0 } })) };
  const claim = { text: "private quote", refs: input.episodes.map((e) => ({ ...scope, subjectKey: e.subjectKey, threadId: e.threadId, episodeId: e.episodeId, revision: 1, statementId: "s", quote: "private quote" })) };
  const artifact: RecommendationArtifact = { schemaVersion: "retrospective-recommendations/v1", artifactId: "artifact1", version: 1, scope, createdAt: now, versions: { generator: "stub", methods: ["v1"] }, contributors: subjects, episodeRefs: input.episodes.map(({ subjectKey, threadId, episodeId, revision }) => ({ subjectKey, threadId, episodeId, revision })), coverage: { episodes: 2, activities: 2, observedHours: 0.8 }, candidates: [{ candidateId: "candidate", status: "checked", review: { operatorId: "private_operator", reviewedAt: now }, operation: claim, opportunity: claim, known: { input: null, output: null, method: claim, criterion: claim }, facts: [claim], hypotheses: [], technicalQuestions: [], unknowns: ["Доступность API"], change: "Подготовить черновик полей", humanControl: "Проверить поля до записи", firstTest: "Проверить одно письмо без записи", expectedSign: "Поля совпали", stopCondition: "Остановить при расхождении", disposition: "recommendation" }] };
  const snapshot: CompanyReportSnapshot = { invitedParticipants: 2, subjects: subjects.map((subjectKey) => ({ subjectKey, roleId: "role_a" })), activities };
  const directory = { schemaVersion: "minutka-routine-directory/v1", companyId: scope.companyId, version: "1", sections: [{ roleId: "role_a", entries: [{ id: "transfer", name: "Перенос полей", description: "Перенос", examples: [], quickWin: "deep_dive", provenance: subjects.map((subjectKey) => ({ groupId: scope.groupId, subjectKey })) }] }] };
  const service = new CompanyReportingService({ loadGroupSnapshot: async () => snapshot }, () => now, { policies: { read: async () => ({ ...scope, enabled, period: { start: now, end: now }, methodVersion: "v1" }) }, readLatest: async () => artifact, research: { read: async () => input } });
  const reporting = { buildReport: async (request: typeof scope) => service.buildReport({ ...request, directory }) };
  const world = createInMemoryWorld(() => now);
  const publishing = new ClientReportPublishingService(reporting, createInMemoryAuditEventStore(world), { now: () => now }, createDeterministicIdGenerator());
  const file = async (): Promise<ReportPreflightFindingsFile> => ({ schemaVersion: "minutka-report-preflight-findings/v1", scope: "company_a/group_a", reportVersion: hashClientReport((await reporting.buildReport(scope)).client), findings: [] });
  return { reporting, publishing, artifact, input, file, world, service, snapshot, directory };
}
describe("Retrospective client publication", () => {
  it("SPEC-RETRO-PUBLISH-01: deterministic checked v3 without generation", async () => {
    const h = setup();
    const a = await h.reporting.buildReport(scope);
    expect(a.client).toEqual((await h.reporting.buildReport(scope)).client);
    expect(a.client.schemaVersion).toBe("minutka-client-report.v3");
    expect(a.client.recommendations).toHaveLength(1);
    expect(a.client.firstSteps).toEqual([]);
    expect(a.client.topRoutines.every((routine) => routine.quickWin === undefined)).toBe(true);
    h.input.episodes[0]!.revision++;
    const stale = await h.reporting.buildReport(scope);
    expect(stale.client.recommendations).toEqual([]);
    expect(stale.client.deepDive).toHaveLength(1);
  });
  it("SPEC-RETRO-PUBLISH-02: high findings, explicit operator gate and stale evidence", async () => {
    const h = setup(); const findings = await h.file();
    expect(await h.publishing.publishClientReport({ ...scope, findings })).toMatchObject({ reason: "operator_decision_required" });
    h.artifact.candidates[0]!.firstTest = "Написать user@example.com";
    const high = await h.file();
    expect(await h.publishing.publishClientReport({ ...scope, findings: high, operatorDecision: "publish" })).toMatchObject({ reason: "unresolved_high_findings" });
    h.input.evidence.activities[0]!.revision = 2;
    expect((await h.reporting.buildReport(scope)).client.recommendations).toEqual([]);
    expect(await h.publishing.publishClientReport({ ...scope, findings: high, operatorDecision: "publish" })).toMatchObject({ reason: "stale_findings" });
    expect(h.world.auditEvents.some((e) => e.type === "client_report_published")).toBe(false);
  });
  it("SPEC-RETRO-PUBLISH-03: projection excludes research identities, quotes and obligations", async () => {
    const h = setup(); const report = await h.reporting.buildReport(scope);
    expect(JSON.stringify(report.client)).not.toMatch(/private_|subjectKey|quote|review|episodeRefs|candidateId/);
    expect(await h.publishing.publishClientReport({ ...scope, findings: await h.file(), operatorDecision: "publish" })).toMatchObject({ ok: true });
    expect(h.world.auditEvents.at(-1)?.metadata.reviewer).toBe("operator");
    h.artifact.candidates[0]!.firstTest = "Repeat private quote";
    expect((await h.reporting.buildReport(scope)).client.recommendations).toEqual([]);
  });
  it("SPEC-RETRO-PUBLISH-04: newer candidate version invalidates earlier findings", async () => {
    const h = setup(); const findings = await h.file(); h.artifact.version = 2; h.artifact.artifactId = "artifact2";
    expect(await h.publishing.publishClientReport({ ...scope, findings, operatorDecision: "publish" })).toMatchObject({ reason: "stale_findings" });
  });
  it.each(["correction", "supersession", "purge"] as const)("SPEC-RETRO-INVALIDATION-01/02: message-only %s invalidates old findings without episode writes", async (mutation) => {
    const h = setup();
    for (const e of h.input.episodes) for (const s of e.statements.actions)
      s.sourceRefs = s.sourceRefs.filter((ref) => ref.type === "message");
    const episodes = structuredClone(h.input.episodes);
    const findings = await h.file();
    if (mutation === "correction") h.input.evidence.activities[0]!.revision = 2;
    if (mutation === "supersession") h.input.evidence.activities[0]!.status = "superseded";
    if (mutation === "purge") h.input.evidence.activities.splice(0, 1);
    expect(h.input.episodes).toEqual(episodes);
    expect((await h.reporting.buildReport(scope)).client.recommendations).toEqual([]);
    expect(await h.publishing.publishClientReport({ ...scope, findings, operatorDecision: "publish" })).toMatchObject({ reason: "stale_findings" });
    expect(h.world.auditEvents.some((e) => e.type === "client_report_published")).toBe(false);
  });
  it("SPEC-RETRO-INVALIDATION-03: fresh checked version and preflight allow deterministic publication", async () => {
    const h = setup();
    for (const e of h.input.episodes) for (const s of e.statements.actions)
      s.sourceRefs = s.sourceRefs.filter((ref) => ref.type === "message");
    const oldFindings = await h.file();
    h.input.evidence.activities[0]!.revision = 2;
    expect((await h.reporting.buildReport(scope)).client.recommendations).toEqual([]);
    // Simulate the new checked artifact from recompute/check (covered by candidate specs).
    h.input.episodes[0]!.activityRefs[0]!.revision = 2;
    h.input.episodes[0]!.revision++;
    h.artifact.episodeRefs[0]!.revision++;
    for (const claim of [h.artifact.candidates[0]!.operation, h.artifact.candidates[0]!.opportunity,
      h.artifact.candidates[0]!.known.method!, h.artifact.candidates[0]!.known.criterion!, ...h.artifact.candidates[0]!.facts])
      claim.refs[0]!.revision = h.input.episodes[0]!.revision;
    h.artifact.version++;
    h.artifact.artifactId = "fresh_checked_artifact";
    expect(await h.publishing.publishClientReport({ ...scope, findings: oldFindings, operatorDecision: "publish" })).toMatchObject({ reason: "stale_findings" });
    expect((await h.reporting.buildReport(scope)).client.recommendations).toHaveLength(1);
    expect(await h.publishing.publishClientReport({ ...scope, findings: await h.file(), operatorDecision: "publish" })).toMatchObject({ ok: true });
  });
  it("SPEC-RETRO-PUBLISH-05: group-off keeps v2", async () => {
    const report = await setup(false).reporting.buildReport(scope);
    expect(report.client.schemaVersion).toBe("minutka-client-report.v2");
    expect(report.client).not.toHaveProperty("recommendations");
    expect(report.client).not.toHaveProperty("recommendationVersion");
  });
});
