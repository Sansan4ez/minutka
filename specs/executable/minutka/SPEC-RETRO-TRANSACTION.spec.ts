import { describe, expect, it } from "vitest";
import { ActivityTransactionService } from "../../../src/application/activity-transaction-service.js";
import { createInMemoryLinkedActivityTransactionStore } from "../../../src/application/linked-activity-transaction-store.js";
import { CollectActivityService } from "../../../src/application/activity-collection.js";
import { ActivityCorrectionService } from "../../../src/application/activity-correction.js";
import { createInMemoryActivityCollectionState, createInMemoryActivityCollectionStore, createInMemoryActivityMutationStore, createInMemoryRecentOwnActivityReadStore } from "../../../src/application/in-memory-activity-collection-store.js";
import { RecentOwnActivitiesService } from "../../../src/application/recent-own-activities.js";
import { createActivityTransactionExtractor } from "../../../src/application/activity-transaction-extractor.js";
import { buildActivityTransactionPrompt } from "../../../src/mastra/activity-transaction-extractor.js";
import { PersistenceOutcomeUnknownError } from "../../../src/application/persistence-error.js";
import type { WorkRetrospectiveEpisode } from "../../../src/domain/work-retrospective.js";

const now = "2026-08-26T12:00:00.000Z";
const scope = { employeeId: "employee_a", companyId: "company_a", groupId: "group_a", subjectKey: "00000000-0000-4000-8000-000000000001", threadId: "thread_a" };
const { threadId: _threadId, ...identity } = scope;
const request = { ...identity, roleId: "role_a", sourceMessageId: "m2", timezone: "Etc/UTC", currentText: "Первое, потом час разбирал заявки", mode: "record" as const, retrospectiveScope: scope };
const patch = { taskCategory: null, routinePattern: null, automationCandidate: null, energyStressMarker: null, system: null, routineId: null, routineLabel: null, recurrence: null, durationRef: null };
function harness(options: { collect?: boolean; stale?: boolean; old?: boolean; foreign?: boolean; none?: boolean; unknown?: boolean } = {}) {
  const state = createInMemoryActivityCollectionState();
  state.activities.push({ ...scope, activityId: "a1", roleId: "role_a", sourceMessageId: "m1", taskCategory: "reporting", routineLabel: "Подготовил отчёт", durationBucket: "15_30m", activityDate: "2026-08-26", recordedAt: options.old ? "2026-08-20T10:00:00.000Z" : "2026-08-26T10:00:00.000Z", revision: options.stale ? 2 : 1, status: "active", ...(options.foreign ? { groupId: "foreign" } : {}) });
  const episode: WorkRetrospectiveEpisode = { ...scope, episodeId: "e1", period: { start: "2026-08-20T00:00:00.000Z", end: "2026-09-01T00:00:00.000Z" }, methodVersion: "v1", messageRefs: [{ messageId: "m1" }], activityRefs: [{ activityId: "a1", revision: 1 }], statements: { actions: [], value: [], future: [], indicators: [] }, revision: 2, status: "active", questionBudget: { localDate: "2026-08-26", dailyDelivered: 1 }, pendingQuestion: { questionId: "q1", text: "Использовали готовый шаблон или сделали с нуля?", sourceTurn: { messageId: "m1" }, target: { episodeId: "e1", revision: 1, stage: "actions", sourceRefs: [{ type: "activity", activityId: "a1", revision: 1 }] } } };
  let generations = 0, writes = 0;
  const extractor = createActivityTransactionExtractor(async ({ prompt }) => {
    generations++;
    expect(prompt).toContain(episode.pendingQuestion!.text);
    return { object: { kind: options.none ? "none" : "linked", reason: options.none ? "no_factual_activity" : null, handle: options.none ? null : "a1", expectedRevision: options.none ? null : 1, correctionMode: options.none ? null : "patch", correction: options.none ? null : { ...patch, routineLabel: "Подготовил отчёт по шаблону" }, activities: options.collect ? [{ ...patch, taskCategory: "admin", routineLabel: "Разбирал заявки", durationRef: "duration_1" }] : [], replacementHandle: null, replacementExpectedRevision: null } };
  }, buildActivityTransactionPrompt);
  const collection = new CollectActivityService(createInMemoryActivityCollectionStore(state), { now: () => now }, () => "a2");
  const ledger = createInMemoryLinkedActivityTransactionStore();
  const deps = { extractor, collection: { async collectBatch(input: Parameters<CollectActivityService["collectBatch"]>[0]) { writes++; if (options.unknown) throw new PersistenceOutcomeUnknownError(); return collection.collectBatch(input); } }, corrections: new ActivityCorrectionService(createInMemoryActivityMutationStore(state), { now: () => now }), recentActivities: new RecentOwnActivitiesService(createInMemoryRecentOwnActivityReadStore(state), { now: () => now }), linkedTransactions: ledger, retrospective: { async readEpisodes() { return { status: "applied" as const, value: [episode] }; } }, clock: { now: () => now } };
  return { state, service: () => new ActivityTransactionService(deps), generations: () => generations, writes: () => writes };
}
describe("linked factual transaction", () => {
  it("SPEC-RETRO-TRANSACTION-05 a reservation without outcome never grants retry", async () => {
    const store = createInMemoryLinkedActivityTransactionStore();
    const key = { ...scope, sourceMessageId: "m2", ordinal: 1 };
    expect(await store.claim(key)).toEqual({ status: "claimed" });
    expect(await store.claim(key)).toEqual({ status: "existing" });
  });
  it("SPEC-RETRO-TRANSACTION-01 short clarification preserves one activity and its time", async () => {
    const h = harness();
    // The bound target is not one of the five most recent activities.
    for (let index = 0; index < 6; index++) h.state.activities.push({ ...h.state.activities[0]!, activityId: `recent_${index}`, recordedAt: "2026-08-26T11:00:00.000Z" });
    expect(await h.service().process({ ...request, currentText: "Первое" })).toMatchObject({ status: "linked", outcomes: [{ status: "completed", revision: 2 }] });
    expect(h.state.activities).toHaveLength(7);
    expect(h.state.activities[0]).toMatchObject({ durationBucket: "15_30m", routineLabel: "Подготовил отчёт по шаблону" });
  });
  it("SPEC-RETRO-TRANSACTION-02 replay across service restart never regenerates or repeats 30+60 minutes", async () => {
    const h = harness({ collect: true });
    const first = await h.service().process(request);
    expect(await h.service().process(request)).toEqual(first);
    expect(h.generations()).toBe(1);
    expect(h.state.activities.map((a) => a.durationBucket)).toEqual(["15_30m", "30_60m"]);
    expect(h.state.activities[0]?.revision).toBe(2);
  });
  it("SPEC-RETRO-TRANSACTION-03 stale correction and successful collect have independent durable outcomes", async () => {
    const h = harness({ collect: true, stale: true });
    const first = await h.service().process(request);
    expect(first).toMatchObject({ status: "linked", outcomes: [{ status: "failed", code: "persistence_conflict" }, { status: "completed", savedCount: 1 }] });
    expect(await h.service().process(request)).toEqual(first);
    expect(h.state.activities).toHaveLength(2);
    expect(h.writes()).toBe(1);
  });
  it.each([{ old: true }, { foreign: true }])("SPEC-RETRO-TRANSACTION-04 rejects expired or foreign target %j", async (options) => {
    const h = harness(options);
    expect(await h.service().process(request)).toMatchObject({ status: "linked", outcomes: [{ status: "failed" }] });
    expect(h.state.activities[0]?.revision).toBe(1);
  });
  it.each(["Обычно делаю так", "Завтра разберу заявки"])("SPEC-RETRO-TRANSACTION-05 no guessed fact: %s", async (currentText) => {
    const h = harness({ none: true });
    expect(await h.service().process({ ...request, currentText })).toMatchObject({ status: "no_write" });
    expect(h.state.activities).toHaveLength(1);
  });
  it("SPEC-RETRO-TRANSACTION-05 unknown write is never retried", async () => {
    const h = harness({ collect: true, unknown: true });
    const result = await h.service().process(request);
    expect(result).toMatchObject({ status: "linked", outcomes: [{ status: "completed" }, { status: "outcome_unknown" }] });
    expect(await h.service().process(request)).toEqual(result);
    expect(h.writes()).toBe(1);
  });
});
