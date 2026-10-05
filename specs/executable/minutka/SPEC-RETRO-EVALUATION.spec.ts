import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, stat, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RetrospectiveEvaluationService, renderRetrospectiveEvaluation, type RetrospectiveMeasurements } from "../../../src/application/retrospective-evaluation.js";
import { type ResearchCorpusExport, researchCorpusExportSchemaVersion } from "../../../src/application/research-corpus-export.js";
import type { WorkRetrospectiveEpisode, WorkRetrospectiveEvent } from "../../../src/domain/work-retrospective.js";
import { runRetrospectiveEvaluationCommand } from "../../../src/runtime/retrospective-evaluation.js";

const now = "2026-08-26T12:00:00.000Z";
const scope = { companyId: "company_a", groupId: "group_a" };
const request = { ...scope, start: "2026-08-26T00:00:00.000Z", end: "2026-09-09T23:59:59.000Z" };
function fixture() {
  const corpus: ResearchCorpusExport = { schemaVersion: researchCorpusExportSchemaVersion, exportedAt: now, scope,
    subjects: [{ subjectKey: "s1", evidenceRefs: [] }], messages: [], activities: [], traces: [], evaluationCases: [],
    versions: { prompts: [], processes: [], taxonomies: [], models: [] },
    coverage: { subjects: 1, messages: 0, activities: 0, traces: 0, feedback: 0, evaluationCases: 0, messagesWithTrace: 0, messagesMissingTrace: 0 } };
  for (let i = 0; i < 4; i++) corpus.messages.push({ messageId: `reply${i}`, subjectKey: "s1", userText: "Employee reply", agentResponse: "Response", timestamp: now,
    metadata: { version: 1, origin: "employee" }, trace: { status: "missing" }, feedback: [] });
  for (let i = 0; i < 8; i++) corpus.messages.push({ messageId: `scheduled${i}`, subjectKey: "s1", userText: "Synthetic prompt", agentResponse: "Prompt", timestamp: now,
    metadata: { version: 1, origin: "scheduled" }, trace: { status: "missing" }, feedback: [] });
  const measurements: RetrospectiveMeasurements = { scope, touches: Array.from({ length: 10 }, (_, i) => ({
    touchId: `touch${i}`, subjectKey: "s1", timestamp: now, process: "evening_reflection", methodVersion: "v1", eligible: true,
    delivery: i < 8 ? "delivered" : "failed", replyMessageIds: i < 4 ? [`reply${i}`] : [`scheduled${i}`], invitation: true,
    ...(i === 0 ? { acceptanceMessageId: "reply0" } : {}), refs: [`delivery-receipt${i}`] })), observations: [], changes: [], omissions: [] };
  return { corpus, measurements, artifacts: [] };
}
function episode(id: string, methodVersion = "v1"): WorkRetrospectiveEpisode {
  return { ...scope, employeeId: "employee_a", subjectKey: "s1", threadId: "thread", episodeId: id,
    methodVersion, period: { start: now, end: request.end }, messageRefs: [{ messageId: "reply0" }], activityRefs: [], revision: 0,
    status: "completed", questionBudget: { localDate: "2026-08-26", dailyDelivered: 0 },
    statements: { actions: [{ statementId: "fact", text: "Prepared report", kind: "employee_fact", sourceRefs: [{ type: "message", messageId: "reply0" }] }], value: [], future: [], indicators: [] },
    selectedStep: { statementId: "step", text: "Try checklist", kind: "intention", sourceRefs: [{ type: "message", messageId: "reply0" }] } };
}
function addEpisode(input: ReturnType<typeof fixture>, e: WorkRetrospectiveEpisode, ordinal = 0) {
  const event: WorkRetrospectiveEvent = { ...scope, employeeId: "employee_a", subjectKey: "s1", threadId: "thread", episodeId: e.episodeId,
    eventId: `event-${e.episodeId}-${ordinal}`, sourceMessageId: "reply0", ordinal, version: 1, expectedRevision: 0, timestamp: now,
    action: { type: "episode_selected", episode: e } };
  input.corpus.messages[0]!.metadata!.retrospectiveEvents ??= [];
  input.corpus.messages[0]!.metadata!.retrospectiveEvents!.push(event);
  return event;
}
const evaluate = (input: ReturnType<typeof fixture>) => new RetrospectiveEvaluationService({ read: async () => input }, undefined, () => now).evaluate(request);

describe("private retrospective evaluation", () => {
  it("SPEC-RETRO-EVALUATION-01 explicit delivery and employee response denominators", async () => {
    const result = await evaluate(fixture());
    expect(result.participation.buckets[0]!.delivery).toEqual({ numerator: 8, denominator: 10, value: .8 });
    expect(result.participation.buckets[0]!.response).toEqual({ numerator: 4, denominator: 8, value: .5 });
    expect(result.participation.scheduledMessages).toBe(8);
    expect(result.participation.buckets[0]!.invitationAcceptance.numerator).toBe(1);
  });
  it("SPEC-RETRO-EVALUATION-02 unknown origin and failed delivery are not refusals", async () => {
    const input = fixture();
    for (let i = 0; i < 3; i++) input.corpus.messages.push({ ...input.corpus.messages[0]!, messageId: `historical${i}`, metadata: undefined });
    input.measurements.touches[4]!.replyMessageIds = ["historical0"];
    const result = await evaluate(input);
    expect(result.participation.unknownOrigin).toBe(3);
    expect(result.participation.buckets[0]!.failed).toBe(2);
    expect(result.participation.buckets[0]!.response.numerator).toBe(4);
    expect(result.episodes.declined).toBe(0);
  });
  it("SPEC-RETRO-EVALUATION-03 selected, attempted and observed results are independent", async () => {
    const input = fixture();
    for (let i = 0; i < 3; i++) addEpisode(input, episode(`e${i}`), i);
    for (let i = 0; i < 2; i++) input.measurements.observations.push({ timestamp: now, subjectKey: "s1", episodeId: `e${i}`, kind: "attempted", refs: ["reply0"] });
    input.measurements.observations.push({ timestamp: now, subjectKey: "s1", episodeId: "e0", kind: "observed_result", refs: ["reply0"] });
    // Repeated observations do not manufacture independent cases.
    input.measurements.observations.push(input.measurements.observations[0]!);
    const result = await evaluate(input);
    expect([result.episodes.selected, result.episodes.attempted, result.episodes.observedResult]).toEqual([3, 2, 1]);
  });
  it("SPEC-RETRO-EVALUATION-04 five follow-ups remain one episode", async () => {
    const input = fixture();
    const event = addEpisode(input, episode("e1"));
    for (let i = 1; i <= 5; i++) input.corpus.messages[0]!.metadata!.retrospectiveEvents!.push({ ...event, eventId: `update${i}`, ordinal: i,
      action: { type: "episode_updated", episode: { ...episode("e1"), revision: i } } });
    const result = await evaluate(input);
    expect(result.episodes.count).toBe(1);
    expect(result.episodes.started).toBe(1);
    expect(result.episodes.quality[0]!.revision).toBe(5);
    expect(result.episodes.stages.actions).toEqual({ numerator: 1, denominator: 1, value: 1 });
  });
  it("SPEC-RETRO-EVALUATION-05 versions, corrections, sparse feedback and limitations survive rendering", async () => {
    const input = fixture();
    addEpisode(input, episode("e1")); addEpisode(input, episode("e2", "v2"), 1);
    input.measurements.touches[0]!.methodVersion = "v2";
    input.measurements.changes.push({ timestamp: now, oldVersion: "v1", newVersion: "v2", reason: "Adjusted wording", refs: ["operator-log"] });
    const result = await evaluate(input);
    const rendered = JSON.parse(renderRetrospectiveEvaluation(result));
    expect(rendered.versions.methods).toEqual(["v1", "v2"]);
    expect(rendered.participation.buckets).toHaveLength(2);
    expect(rendered.participation.feedbackRespondents).toEqual({ numerator: 0, denominator: 1, value: 0 });
    expect(rendered.changes[0].reason).toBe("Adjusted wording");
    expect(rendered.conclusion).toContain("no causal uplift or proven effect");
    expect(rendered.omissions.join(" ")).toContain("semantic rubric");
  });
  it("rejects cross-tenant evidence and shows missing measurements rather than inferred counts", async () => {
    const input = fixture(); input.corpus.scope = { ...scope, groupId: "other" };
    await expect(evaluate(input)).rejects.toThrow("cross_scope");
    const service = new RetrospectiveEvaluationService({ read: async () => ({ corpus: fixture().corpus, artifacts: [] }) });
    const result = await service.evaluate(request);
    expect(result.participation.buckets).toEqual([]);
    expect(result.omissions.join(" ")).toContain("receipts unavailable");
  });
  it("agent rubric cannot manufacture evidence refs", async () => {
    const input = fixture();
    const service = new RetrospectiveEvaluationService({ read: async () => input }, { version: "stub/v1", evaluate: async () => [{
      candidateId: "absent", operation: "supported", claims: "supported", firstTest: "unknown", humanControl: "unknown", unknowns: "unknown",
      refs: ["invented-message"], disputedCases: [],
    }] });
    await expect(service.evaluate(request)).rejects.toThrow("unsupported_rubric_evidence");
  });
  it("CLI writes private output outside Git and rejects repository output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "retro-evaluation-"));
    try {
      const input = join(dir, "input.json"), output = join(dir, "evaluation.json");
      await writeFile(input, JSON.stringify(fixture()));
      const args = ["--company", scope.companyId, "--group", scope.groupId, "--from", request.start, "--to", request.end, "--input", input, "--output"];
      await expect(runRetrospectiveEvaluationCommand([...args, join(process.cwd(), "private.json")], { repoRoot: process.cwd() })).rejects.toThrow("outside");
      await runRetrospectiveEvaluationCommand([...args, output], { repoRoot: process.cwd() });
      expect(JSON.parse(await readFile(output, "utf8")).visibility).toBe("private_research");
      expect((await stat(output)).mode & 0o777).toBe(0o600);
      await expect(runRetrospectiveEvaluationCommand([...args, output], { repoRoot: process.cwd() })).rejects.toThrow();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
