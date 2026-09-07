import { describe, expect, it } from "vitest";
import { CollectActivityService, type PersonalActivityRecord } from "../../../src/application/activity-collection.js";
import { ActivityCorrectionService } from "../../../src/application/activity-correction.js";
import type {
  ActivityTransactionDecision,
  ActivityTransactionExtractor,
  ActivityTransactionExtractorInput,
} from "../../../src/application/activity-transaction-extractor.js";
import { MAX_DURATION_REFERENCES } from "../../../src/application/activity-duration-evidence.js";
import { ActivityTransactionService } from "../../../src/application/activity-transaction-service.js";
import {
  createInMemoryActivityCollectionState,
  createInMemoryActivityCollectionStore,
  createInMemoryActivityMutationStore,
  createInMemoryRecentOwnActivityReadStore,
} from "../../../src/application/in-memory-activity-collection-store.js";
import { PersistenceError, PersistenceOutcomeUnknownError } from "../../../src/application/persistence-error.js";
import { RecentOwnActivitiesService } from "../../../src/application/recent-own-activities.js";

const now = "2026-08-26T12:00:00.000Z";
const request = {
  employeeId: "employee_a",
  companyId: "company_a",
  groupId: "group_a",
  subjectKey: "00000000-0000-4000-8000-000000000001",
  sourceMessageId: "message_current",
  roleId: "role_a",
  timezone: "Etc/UTC",
  currentText: "Подготовил отчёт за 35 минут.",
};
const context = {
  currentTextCharacters: 10,
  staticRulesCharacters: 20,
  durationReferencesCharacters: 30,
  recentCandidatesCharacters: 0,
  promptCharacters: 60,
};

function row(overrides: Partial<PersonalActivityRecord> = {}): PersonalActivityRecord {
  return {
    activityId: "activity_a",
    employeeId: request.employeeId,
    subjectKey: request.subjectKey,
    sourceMessageId: "message_original",
    companyId: request.companyId,
    groupId: request.groupId,
    roleId: request.roleId,
    taskCategory: "reporting",
    activityDate: "2026-08-26",
    recordedAt: "2026-08-26T10:00:00.000Z",
    revision: 1,
    status: "active",
    ...overrides,
  };
}

function harness(
  decide: ActivityTransactionDecision | ((input: ActivityTransactionExtractorInput) => ActivityTransactionDecision),
  options: {
    rows?: PersonalActivityRecord[];
    collection?: Pick<CollectActivityService, "collectBatch">;
    recentRead?: (input: { employeeId: string; companyId: string; groupId: string }) => Promise<{ activities: never[] }>;
    corrections?: Pick<ActivityCorrectionService, "correct" | "supersede">;
    routineDirectorySectionProvider?: (companyId: string, roleId: string) => import("../../../src/application/routine-directory.js").RoutineDirectorySection | undefined;
  } = {},
) {
  const state = createInMemoryActivityCollectionState();
  state.activities.push(...(options.rows ?? []));
  const extractorInputs: ActivityTransactionExtractorInput[] = [];
  const extractor: ActivityTransactionExtractor = async (input) => {
    extractorInputs.push(input);
    return { status: "completed", decision: typeof decide === "function" ? decide(input) : decide, context };
  };
  const collection = options.collection ?? new CollectActivityService(
    createInMemoryActivityCollectionStore(state),
    { now: () => now },
    (() => {
      let id = 0;
      return () => `activity_new_${++id}`;
    })(),
  );
  const realRecent = new RecentOwnActivitiesService(createInMemoryRecentOwnActivityReadStore(state), { now: () => now });
  let recentReads = 0;
  const recentActivities = {
    async read(input: { employeeId: string; companyId: string; groupId: string }) {
      recentReads += 1;
      if (options.recentRead) return options.recentRead(input);
      return realRecent.read(input);
    },
  };
  const corrections = options.corrections ?? new ActivityCorrectionService(
    createInMemoryActivityMutationStore(state),
    { now: () => now },
  );
  const service = new ActivityTransactionService({
    extractor,
    collection,
    recentActivities,
    corrections,
    routineDirectorySectionProvider: options.routineDirectorySectionProvider,
    clock: { now: () => now },
  });
  return { service, state, extractorInputs, recentReads: () => recentReads };
}

describe("SPEC-MINUTKA-ACTIVITY-TRANSACTION-SERVICE-001: bounded application transaction", () => {
  it("caps duration references before extraction without throwing", async () => {
    const currentText = Array.from({ length: MAX_DURATION_REFERENCES + 1 }, (_, index) => `Задача ${index + 1}: 5 мин.`).join(" ");
    const { service, extractorInputs } = harness({ kind: "none", reason: "no_factual_activity" });

    await expect(service.process({ ...request, currentText, mode: "record" })).resolves.toMatchObject({
      status: "no_write",
      reason: "no_factual_activity",
    });
    expect(extractorInputs).toHaveLength(1);
    expect(extractorInputs[0]?.durationReferences).toHaveLength(MAX_DURATION_REFERENCES);
    expect(extractorInputs[0]?.durationReferences.at(-1)).toEqual({
      ref: "duration_32",
      bucket: "lt_15m",
      sourceOrder: 31,
    });
  });

  it("binds trusted scope outside extractor input and records repeated work without a recent read", async () => {
    const { service, state, extractorInputs, recentReads } = harness({
      kind: "collect",
      activities: [{ taskCategory: "reporting", system: "spreadsheets", durationRef: "duration_1" }],
    }, { rows: [row()] });

    const bound = service.bind(request);
    await expect(bound({ mode: "record" })).resolves.toMatchObject({
      status: "completed", operation: "collect", savedCount: 1, activityIds: ["activity_new_1"],
      extraction: {
        decision: { kind: "collect", activities: [{ taskCategory: "reporting", system: "spreadsheets", durationRef: "duration_1" }] },
        latencyMs: expect.any(Number),
      },
    });

    expect(recentReads()).toBe(0);
    expect(extractorInputs).toEqual([{
      mode: "record",
      currentText: request.currentText,
      durationReferences: [{ ref: "duration_1", bucket: "30_60m", sourceOrder: 0 }],
    }]);
    expect(JSON.stringify(extractorInputs)).not.toMatch(/employee_a|company_a|group_a|subjectKey|message_current|role_a|Etc\/UTC/u);
    expect(state.activities).toHaveLength(2);
    expect(state.activities[1]).toMatchObject({
      employeeId: request.employeeId,
      companyId: request.companyId,
      groupId: request.groupId,
      subjectKey: request.subjectKey,
      sourceMessageId: request.sourceMessageId,
      roleId: request.roleId,
      taskCategory: "reporting",
      system: "spreadsheets",
      durationBucket: "30_60m",
    });
    expect(JSON.stringify(state.activities[1])).not.toContain("duration_1");
  });

  it.each([
    ["30 минут", "15_30m"],
    ["3 часа", "2_4h"],
    ["уже минут 30", "15_30m"],
  ] as const)("repairs the latest same-day activity for duration-only reply %s instead of collecting", async (currentText, durationBucket) => {
    const rows = [
      row({ activityId: "activity_latest", recordedAt: "2026-08-26T11:00:00.000Z" }),
      row({ activityId: "activity_earlier", recordedAt: "2026-08-26T09:00:00.000Z" }),
      row({ activityId: "activity_yesterday", activityDate: "2026-08-25", recordedAt: "2026-08-25T11:30:00.000Z" }),
    ];
    let collectionCalls = 0;
    const realCollection = new CollectActivityService(createInMemoryActivityCollectionStore({ activities: rows }), { now: () => now });
    const { service, state, extractorInputs, recentReads } = harness((input) => {
      if (input.mode !== "repair") throw new Error("duration-only reply must use repair");
      return {
        kind: "correct",
        handle: input.recentCandidates[0]!.handle,
        expectedRevision: input.recentCandidates[0]!.revision,
        mode: "patch",
        correction: { durationRef: "duration_1" },
      };
    }, {
      rows,
      collection: {
        async collectBatch(input) {
          collectionCalls += 1;
          return realCollection.collectBatch(input);
        },
      },
    });

    await expect(service.process({ ...request, currentText, mode: "record" }))
      .resolves.toMatchObject({ status: "completed", operation: "correct", handle: "activity_latest", revision: 2 });
    expect(collectionCalls).toBe(0);
    expect(recentReads()).toBe(1);
    expect(extractorInputs).toEqual([{
      mode: "repair",
      currentText,
      durationReferences: [{ ref: "duration_1", bucket: durationBucket, sourceOrder: 0 }],
      recentCandidates: [
        expect.objectContaining({ handle: "activity_latest", activityDate: "2026-08-26" }),
        expect.objectContaining({ handle: "activity_earlier", activityDate: "2026-08-26" }),
      ],
    }]);
    expect(state.activities).toHaveLength(3);
    expect(state.activities.find(({ activityId }) => activityId === "activity_latest")).toMatchObject({
      durationBucket,
      revision: 2,
      lastCorrectionMessageId: request.sourceMessageId,
    });
  });

  it("passes the participant company and role directory section to extraction", async () => {
    const directorySection = {
      version: "directory-v1",
      entries: [{ id: "routine-report", name: "Prepare reports", description: "Prepare reports", examples: ["prepared a report"] }],
    };
    const calls: Array<[string, string]> = [];
    const { service, extractorInputs } = harness({ kind: "none", reason: "no_factual_activity" }, {
      routineDirectorySectionProvider: (companyId, roleId) => {
        calls.push([companyId, roleId]);
        return companyId === request.companyId && roleId === request.roleId ? directorySection : undefined;
      },
    });

    await service.process({ ...request, mode: "record" });
    await service.process({ ...request, companyId: "company_other", mode: "record" });
    await service.process({ ...request, roleId: "role_other", mode: "record" });

    expect(calls).toEqual([
      [request.companyId, request.roleId],
      ["company_other", request.roleId],
      [request.companyId, "role_other"],
    ]);
    expect(extractorInputs[0]).toMatchObject({ directorySection });
    expect(extractorInputs[1]).not.toHaveProperty("directorySection");
    expect(extractorInputs[2]).not.toHaveProperty("directorySection");
  });

  it("keeps the extractor input unchanged when no directory provider is configured", async () => {
    const { service, extractorInputs } = harness({ kind: "none", reason: "no_factual_activity" });

    await service.process({ ...request, mode: "record" });

    expect(extractorInputs[0]).toEqual({
      mode: "record",
      currentText: request.currentText,
      durationReferences: [{ ref: "duration_1", bucket: "30_60m", sourceOrder: 0 }],
    });
  });

  it("keeps work-bearing reversed wording in record mode without false duration evidence", async () => {
    let collectionCalls = 0;
    const { service, extractorInputs, recentReads } = harness((input) => {
      expect(input).toEqual({ mode: "record", currentText: "За час 3 заявки", durationReferences: [] });
      return { kind: "collect", activities: [{ taskCategory: "communication" }] };
    }, {
      rows: [row()],
      collection: {
        async collectBatch(input) {
          collectionCalls += 1;
          expect(input.activities).toEqual([expect.objectContaining({ taskCategory: "communication" })]);
          return { status: "completed", savedCount: 1, activityIds: ["activity_new"] };
        },
      },
    });

    await expect(service.process({ ...request, currentText: "За час 3 заявки", mode: "record" }))
      .resolves.toMatchObject({ status: "completed", operation: "collect", savedCount: 1 });
    expect(extractorInputs).toEqual([{ mode: "record", currentText: "За час 3 заявки", durationReferences: [] }]);
    expect(recentReads()).toBe(0);
    expect(collectionCalls).toBe(1);
  });

  it("returns clarification without collecting when duration-only reply has no same-day activity", async () => {
    let collectionCalls = 0;
    const { service, extractorInputs } = harness((input) => {
      if (input.mode !== "repair") throw new Error("duration-only reply must use repair");
      expect(input.recentCandidates).toEqual([]);
      return { kind: "needs_clarification", reason: "repair_target_not_found" };
    }, {
      rows: [row({ activityDate: "2026-08-25", recordedAt: "2026-08-25T11:30:00.000Z" })],
      collection: { async collectBatch() { collectionCalls += 1; throw new Error("must not collect"); } },
    });

    await expect(service.process({ ...request, currentText: "30 минут", mode: "record" }))
      .resolves.toMatchObject({ status: "needs_clarification", reason: "repair_target_not_found" });
    expect(extractorInputs[0]).toMatchObject({ mode: "repair", recentCandidates: [] });
    expect(collectionCalls).toBe(0);
  });

  it("reads at most five active own rows and performs one exact revisioned correction", async () => {
    const rows = Array.from({ length: 7 }, (_, index) => row({
      activityId: `activity_${index + 1}`,
      recordedAt: new Date(Date.parse(now) - (index + 1) * 60_000).toISOString(),
    })).concat([
      row({ activityId: "foreign_owner", employeeId: "employee_b" }),
      row({ activityId: "superseded", status: "superseded" }),
    ]);
    let correctionCalls = 0;
    const corrections = new ActivityCorrectionService(createInMemoryActivityMutationStore({ activities: rows }), { now: () => now });
    const { service, extractorInputs, recentReads } = harness((input) => {
      if (input.mode !== "repair") throw new Error("expected repair input");
      return {
        kind: "correct",
        handle: input.recentCandidates[0]!.handle,
        expectedRevision: input.recentCandidates[0]!.revision,
        mode: "patch",
        correction: { routinePattern: "waiting_for_input" },
      };
    }, {
      rows,
      corrections: {
        async correct(scope, input) {
          correctionCalls += 1;
          return corrections.correct(scope, input);
        },
        supersede: corrections.supersede.bind(corrections),
      },
    });

    await expect(service.process({ ...request, currentText: "Нет, ждал данные для отчёта.", mode: "repair" }))
      .resolves.toMatchObject({ status: "completed", operation: "correct", handle: "activity_1", revision: 2 });
    expect(recentReads()).toBe(1);
    expect(correctionCalls).toBe(1);
    expect(extractorInputs[0]).toMatchObject({ mode: "repair" });
    if (extractorInputs[0]?.mode !== "repair") throw new Error("expected repair input");
    expect(extractorInputs[0].recentCandidates).toHaveLength(5);
    expect(extractorInputs[0].recentCandidates.map(({ handle }) => handle)).toEqual([
      "activity_1", "activity_2", "activity_3", "activity_4", "activity_5",
    ]);
  });

  it("performs one exact duplicate supersession and leaves ambiguity as a no-write result", async () => {
    const duplicateRows = [
      row({ activityId: "activity_keep", recordedAt: "2026-08-26T09:00:00.000Z" }),
      row({ activityId: "activity_duplicate", recordedAt: "2026-08-26T10:00:00.000Z" }),
    ];
    let supersedeCalls = 0;
    const mutations = new ActivityCorrectionService(createInMemoryActivityMutationStore({ activities: duplicateRows }), { now: () => now });
    const exact = harness({
      kind: "supersede",
      handle: "activity_duplicate",
      expectedRevision: 1,
      replacementHandle: "activity_keep",
      replacementExpectedRevision: 1,
    }, {
      rows: duplicateRows,
      corrections: {
        correct: mutations.correct.bind(mutations),
        async supersede(scope, input) {
          supersedeCalls += 1;
          return mutations.supersede(scope, input);
        },
      },
    });
    await expect(exact.service.process({ ...request, currentText: "Вторая запись дублирует первую.", mode: "repair" }))
      .resolves.toMatchObject({ status: "completed", operation: "supersede", handle: "activity_duplicate", revision: 2 });
    expect(supersedeCalls).toBe(1);

    let writeCalls = 0;
    const ambiguous = harness({ kind: "needs_clarification", reason: "duplicate_pair_ambiguous" }, {
      rows: duplicateRows,
      collection: { async collectBatch() { writeCalls += 1; throw new Error("must not write"); } },
      corrections: {
        async correct() { writeCalls += 1; throw new Error("must not write"); },
        async supersede() { writeCalls += 1; throw new Error("must not write"); },
      },
    });
    await expect(ambiguous.service.process({ ...request, currentText: "Одна из них дублируется.", mode: "repair" }))
      .resolves.toMatchObject({ status: "needs_clarification", reason: "duplicate_pair_ambiguous" });
    expect(writeCalls).toBe(0);
  });

  it("returns bounded failures, preserves partial writes, and never retries outcome-unknown mutations", async () => {
    let unknownWrites = 0;
    const unknown = harness({ kind: "collect", activities: [{ taskCategory: "reporting" }] }, {
      collection: {
        async collectBatch() {
          unknownWrites += 1;
          throw new PersistenceOutcomeUnknownError();
        },
      },
    });
    await expect(unknown.service.process({ ...request, mode: "record" }))
      .resolves.toMatchObject({ status: "outcome_unknown", phase: "write" });
    expect(unknownWrites).toBe(1);

    let partialWrites = 0;
    const partial = harness({
      kind: "collect",
      activities: [{ taskCategory: "reporting" }, { taskCategory: "meetings" }],
    }, {
      collection: {
        async collectBatch() {
          partialWrites += 1;
          return {
            status: "partial",
            savedCount: 1,
            activityIds: ["activity_saved"],
            error: new PersistenceError("persistence_unavailable"),
          };
        },
      },
    });
    await expect(partial.service.process({ ...request, mode: "record" })).resolves.toMatchObject({
      status: "partial", operation: "collect", savedCount: 1, activityIds: ["activity_saved"], code: "persistence_unavailable",
    });
    expect(partialWrites).toBe(1);

    const failedExtractor = new ActivityTransactionService({
      extractor: async () => ({ status: "failed", code: "provider_error", context }),
      collection: { async collectBatch() { throw new Error("must not write"); } },
      recentActivities: { async read() { throw new Error("must not read"); } },
      corrections: {
        async correct() { throw new Error("must not write"); },
        async supersede() { throw new Error("must not write"); },
      },
    });
    await expect(failedExtractor.process({ ...request, mode: "record" }))
      .resolves.toMatchObject({ status: "failed", phase: "extract", code: "provider_error" });
  });
});
