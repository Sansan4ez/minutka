import { describe, expect, it } from "vitest";
import { createInMemoryArtifactStore } from "../../../src/application/in-memory-artifact-store.js";
import { createInMemoryArtifactContentStore } from "../../../src/application/in-memory-artifact-content-store.js";
import { RetrospectiveRecommendationService, createRecommendationResearchRead, currentCheckedRecommendations, type RecommendationInput, type RecommendationProposal, type RecommendationArtifact } from "../../../src/application/retrospective-recommendations.js";
import { buildRetrospectiveRecommendationPrompt } from "../../../src/mastra/retrospective-recommendation-generator.js";
import { durationBucketHours } from "../../../src/application/company-reporting.js";

const scope = { companyId: "company_a", groupId: "group_a" };
const now = "2026-08-26T12:00:00.000Z";
const quote = "Перенёс поля суммы и даты из письма в CRM и сверил с письмом.";
function fixture(): RecommendationInput {
  return { scope, episodes: [{
    ...scope, subjectKey: "subject_a", threadId: "thread_a", episodeId: "episode_a", revision: 4, methodVersion: "method/v1",
    period: { start: now, end: now }, messageRefs: [1, 2, 3, 4].map((i) => ({ messageId: `message_${i}` })),
    activityRefs: [{ activityId: "activity_a", revision: 1 }], status: "completed",
    statements: { actions: [{ statementId: "statement_a", kind: "employee_fact", text: quote, sourceRefs: [{ type: "message", messageId: "message_1" }, { type: "activity", activityId: "activity_a", revision: 1 }] }], value: [], future: [], indicators: [] },
    questionBudget: { localDate: "2026-08-26", dailyDelivered: 4 },
  }], evidence: {
    messages: [1, 2, 3, 4].map((i) => ({ messageId: `message_${i}`, subjectKey: "subject_a", userText: i === 1 ? quote : "Уточнение того же случая", agentResponse: "", timestamp: now })),
    activities: [{ ...scope, subjectKey: "subject_a", activityId: "activity_a", roleId: "role_a", activityDate: "2026-08-26", recordedAt: now, durationBucket: "15_30m", revision: 1, status: "active" }],
  } };
}
function proposal(input = fixture()): RecommendationProposal {
  const e = input.episodes[0]!;
  const ref = { ...scope, subjectKey: e.subjectKey, threadId: e.threadId, episodeId: e.episodeId, revision: e.revision, statementId: "statement_a", quote: e.statements.actions[0]!.text };
  const claim = { text: quote, refs: [ref] };
  return { operation: claim, opportunity: claim, known: { input: claim, output: claim, method: claim, criterion: claim }, unknowns: ["Доступность API CRM"],
    change: "Попробовать черновик полей суммы и даты", humanControl: "Человек сверяет сумму и дату с письмом перед записью",
    firstTest: "На одном письме подготовить поля суммы и даты и сверить их с письмом без записи в CRM",
    expectedSign: "Оба поля совпали с письмом", stopCondition: "При несовпадении хотя бы одного поля остановить тест",
    facts: [claim], hypotheses: ["Черновик может уменьшить ручной перенос"], technicalQuestions: ["Как разрешён доступ к CRM?"], disposition: "recommendation" };
}
function setup(input = fixture(), generate = async () => [proposal(input)]) {
  const clock = { now: () => now };
  const contents = createInMemoryArtifactContentStore(clock);
  const bodies = new Map<string, string>();
  const put = contents.put.bind(contents);
  contents.put = async (request) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request.openStream()) chunks.push(Buffer.from(chunk));
    bodies.set(`${request.ownerId}/${request.contentDigest}`, Buffer.concat(chunks).toString());
    return put(request);
  };
  const artifacts = createInMemoryArtifactStore({ contentStore: contents, clock, limits: { maximumBytes: 1_000_000, timeoutMs: 1000 } });
  let nextId = 0;
  const deps = { research: { read: async () => input }, generator: { version: "stub/v1", generate }, artifacts, contents, clock, id: () => `candidate_artifact_${++nextId}`,
    loadContent: async (url: string) => {
      const parsed = new URL(url);
      const digest = parsed.pathname.split("/").at(-1)!;
      return bodies.get(`${decodeURIComponent(parsed.pathname.split("/")[1]!)}/${digest}`)!;
    } };
  return { service: new RetrospectiveRecommendationService(deps), deps, input };
}
async function build(service: RetrospectiveRecommendationService): Promise<RecommendationArtifact> {
  const result = await service.build(scope);
  expect(result.status).toBe("applied");
  if (result.status !== "applied") throw new Error("build failed");
  return result.value;
}

describe("Private retrospective recommendation candidates", () => {
  it("SPEC-RETRO-CANDIDATE-01: field-transfer test cites canonical statements and requires operator review", async () => {
    const { service, input } = setup();
    const artifact = await build(service);
    expect(artifact.candidates[0]!.firstTest).toContain("поля суммы и даты");
    expect(artifact.candidates[0]!.facts[0]!.refs[0]!.quote).toBe(quote);
    expect(artifact.candidates[0]!.status).toBe("draft");
    expect(buildRetrospectiveRecommendationPrompt(input)).toContain("NOT independent expertise");
    const reviewed = await service.check(scope, artifact, { operatorId: "operator", decisions: { [artifact.candidates[0]!.candidateId]: "checked" } });
    expect(reviewed.status === "applied" && reviewed.value.candidates[0]!.status).toBe("checked");
    expect(reviewed.status === "applied" && reviewed.value.version).toBe(2);
  });

  it("SPEC-RETRO-CANDIDATE-02: systems alone yield deep_dive, not an invented integration", async () => {
    const input = fixture();
    input.episodes[0]!.statements.actions[0]!.text = "Работаю в CRM и почте";
    input.evidence.messages[0]!.userText = "Работаю в CRM и почте";
    const p = proposal(input);
    p.known.method = null; p.known.criterion = null; p.unknowns = ["Какие поля переносятся и как проверяются?"];
    const artifact = await build(setup(input, async () => [p]).service);
    expect(artifact.candidates[0]).toMatchObject({ status: "rejected", disposition: "deep_dive", change: null, firstTest: null });
    expect(artifact.candidates[0]!.unknowns).toHaveLength(1);
  });

  it("SPEC-RETRO-CANDIDATE-03: four clarifications and duplicate snapshots count one episode and one activity", async () => {
    const input = fixture();
    input.episodes.push(structuredClone(input.episodes[0]!));
    const artifact = await build(setup(input).service);
    expect(artifact.coverage).toEqual({ episodes: 1, activities: 1, observedHours: durationBucketHours["15_30m"] });
    expect(artifact.contributors).toEqual(["subject_a"]);
  });

  it("SPEC-RETRO-CANDIDATE-04: cross-group, stale episode/activity revision, or unsupported quote cannot be checked", async () => {
    for (const mutation of ["group", "episode", "activity", "quote"] as const) {
      const { service, input } = setup();
      const artifact = await build(service);
      if (mutation === "group") artifact.candidates[0]!.operation.refs[0]!.groupId = "group_b";
      if (mutation === "episode") input.episodes[0]!.revision++;
      if (mutation === "activity") input.evidence.activities[0]!.revision = 2;
      if (mutation === "quote") input.evidence.messages[0]!.userText = "Другой текст";
      const checked = await service.check(scope, artifact, { operatorId: "operator", decisions: { [artifact.candidates[0]!.candidateId]: "checked" } });
      expect(checked.status === "applied" && checked.value.candidates[0]!.status).toBe("stale");
    }
    const { service } = setup();
    expect((await service.check({ ...scope, groupId: "group_b" }, await build(service), { operatorId: "op", decisions: {} })).status).toBe("forbidden");
  });

  it("SPEC-RETRO-CANDIDATE-05: new service instance reads immutable version/status/refs from artifact storage", async () => {
    const { service, deps } = setup();
    const artifact = await build(service);
    const checked = await service.check(scope, artifact, { operatorId: "operator", decisions: { [artifact.candidates[0]!.candidateId]: "checked" } });
    if (checked.status !== "applied") throw new Error("check failed");
    expect((await service.save(scope, artifact)).status).toBe("applied");
    expect((await service.save(scope, checked.value)).status).toBe("applied");
    const restarted = new RetrospectiveRecommendationService(deps);
    expect(await restarted.read(scope, checked.value.artifactId)).toEqual({ status: "applied", value: checked.value });
    expect(await restarted.read(scope, artifact.artifactId)).toEqual({ status: "applied", value: artifact });
    expect((await restarted.read({ ...scope, groupId: "group_b" }, artifact.artifactId)).status).toBe("not_found");
  });

  it.each(["correction", "supersession", "purge", "foreign_subject"] as const)("SPEC-RETRO-INVALIDATION-01/02: message-only %s blocks read/check/save/current approval", async (mutation) => {
    const input = fixture();
    input.episodes[0]!.statements.actions[0]!.sourceRefs = [{ type: "message", messageId: "message_1" }];
    const { service } = setup(input);
    const draft = await build(service);
    const review = { operatorId: "operator", decisions: { [draft.candidates[0]!.candidateId]: "checked" as const } };
    const checked = await service.check(scope, draft, review);
    if (checked.status !== "applied") throw new Error("check failed");
    expect((await service.save(scope, checked.value)).status).toBe("applied");
    const episodes = structuredClone(input.episodes);
    if (mutation === "correction") input.evidence.activities[0]!.revision = 2;
    if (mutation === "supersession") input.evidence.activities[0]!.status = "superseded";
    if (mutation === "purge") input.evidence.activities = [];
    if (mutation === "foreign_subject") input.evidence.activities[0]!.subjectKey = "other_subject";
    expect(input.episodes).toEqual(episodes);
    expect(currentCheckedRecommendations(scope, checked.value, input)).toEqual([]);
    expect((await service.save(scope, checked.value)).status).toBe("stale");
    const read = await service.readLatest(scope);
    expect(read.status === "applied" && read.value.candidates[0]).toMatchObject({ status: "stale" });
    expect(read.status === "applied" && read.value.candidates[0]).not.toHaveProperty("review");
    const rechecked = await service.check(scope, checked.value, review);
    expect(rechecked.status === "applied" && rechecked.value.candidates[0]!.status).toBe("stale");
    expect((await build(service)).candidates[0]!.status).toBe("rejected");
  });

  it("SPEC-RETRO-INVALIDATION-03: recompute needs fresh review; current publish validation never generates", async () => {
    const input = fixture();
    input.episodes[0]!.statements.actions[0]!.sourceRefs = [{ type: "message", messageId: "message_1" }];
    let generations = 0;
    const { service } = setup(input, async () => { generations++; return [proposal(input)]; });
    const draft = await build(service);
    const checked = await service.check(scope, draft, { operatorId: "op", decisions: { [draft.candidates[0]!.candidateId]: "checked" } });
    if (checked.status !== "applied") throw new Error("check failed");
    input.evidence.activities[0]!.revision = 2;
    expect(currentCheckedRecommendations(scope, checked.value, input)).toEqual([]);
    input.episodes[0]!.activityRefs[0]!.revision = 2;
    input.episodes[0]!.revision++;
    const recomputed = await service.recompute(scope, checked.value);
    if (recomputed.status !== "applied") throw new Error("recompute failed");
    expect(recomputed.value.candidates[0]).toMatchObject({ status: "draft" });
    expect(recomputed.value.candidates[0]).not.toHaveProperty("review");
    expect(currentCheckedRecommendations(scope, recomputed.value, input)).toEqual([]);
    const reviewed = await service.check(scope, recomputed.value, { operatorId: "op", decisions: { [recomputed.value.candidates[0]!.candidateId]: "checked" } });
    if (reviewed.status !== "applied") throw new Error("check failed");
    expect((await service.save(scope, reviewed.value)).status).toBe("applied");
    expect(currentCheckedRecommendations(scope, reviewed.value, input)).toHaveLength(1);
    expect(generations).toBe(2);
  });

  it("typed research adapter strips employee identity and rejects cross-group discovery", async () => {
    const input = fixture();
    const participant = { ...scope, employeeId: "private_employee", subjectKey: "subject_a", threadId: "thread_a" };
    const deps = { participants: async () => [participant], episodes: { readEpisodes: async () => ({ status: "applied" as const, value: input.episodes.map((e) => ({ ...e, employeeId: participant.employeeId })) }) }, evidence: { listRoutineEvidence: async () => input.evidence } };
    const read = createRecommendationResearchRead(deps);
    expect(JSON.stringify(await read.read(scope))).not.toContain("private_employee");
    participant.groupId = "group_b";
    await expect(read.read(scope)).rejects.toThrow("cross_scope_participant");
  });
});
