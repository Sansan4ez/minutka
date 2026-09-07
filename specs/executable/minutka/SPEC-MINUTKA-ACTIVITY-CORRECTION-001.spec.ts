import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ActivityCorrectionService } from "../../../src/application/activity-correction.js";
import type { PersonalActivityRecord } from "../../../src/application/activity-collection.js";
import {
  createInMemoryActivityCollectionState,
  createInMemoryActivityMutationStore,
  createInMemoryOwnActivityReadStore,
  createInMemoryRecentOwnActivityReadStore,
} from "../../../src/application/in-memory-activity-collection-store.js";
import { createInMemoryCompanyReportStore } from "../../../src/application/in-memory-company-report-store.js";
import { RecentOwnActivitiesService } from "../../../src/application/recent-own-activities.js";
import { WeeklyActivitySummaryService } from "../../../src/application/weekly-activity-summary.js";
import { CycleActivitySummaryService } from "../../../src/application/cycle-activity-summary.js";
import { CompanyReportingService } from "../../../src/application/company-reporting.js";
import { PersistenceError } from "../../../src/application/persistence-error.js";
import {
  createCorrectRecentActivityTool,
  createSupersedeRecentActivityTool,
} from "../../../src/mastra/tools/activity-correction-tools.js";
import type { Participant } from "../../../src/domain/employee.js";
import { extractDurationEvidence, RequestDurationEvidence } from "../../../src/application/activity-duration-evidence.js";
import { expectActivityMutationResultContract } from "../support/activity-mutation-store-contract.js";

const now = "2026-08-24T12:00:00.000Z";
const scope = { employeeId: "employee_a", companyId: "company_a", groupId: "group_a" };

function activity(overrides: Partial<PersonalActivityRecord> = {}): PersonalActivityRecord {
  return {
    activityId: "activity_a",
    employeeId: scope.employeeId,
    subjectKey: "00000000-0000-4000-8000-000000000001",
    sourceMessageId: "message_original",
    companyId: scope.companyId,
    groupId: scope.groupId,
    roleId: "role_a",
    taskCategory: "reporting",
    routinePattern: "manual_reporting",
    activityDate: "2026-08-24",
    recordedAt: "2026-08-24T10:00:00.000Z",
    revision: 1,
    status: "active",
    updatedAt: "2026-08-24T10:00:00.000Z",
    ...overrides,
  };
}

function participant(overrides: Partial<Participant> = {}): Participant {
  return {
    employeeId: scope.employeeId,
    companyId: scope.companyId,
    groupId: scope.groupId,
    subjectKey: "00000000-0000-4000-8000-000000000001",
    roleId: "role_a",
    status: "profile_completed",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function service(rows: PersonalActivityRecord[]) {
  const state = createInMemoryActivityCollectionState();
  state.activities.push(...rows);
  return {
    state,
    corrections: new ActivityCorrectionService(createInMemoryActivityMutationStore(state), { now: () => now }),
  };
}

const conflict = new PersistenceError("persistence_conflict");

describe("SPEC-MINUTKA-ACTIVITY-CORRECTION-001: revisioned local activity repair", () => {
  it("returns mutation records without embedded revision history from the in-memory adapter", async () => {
    const state = createInMemoryActivityCollectionState();
    state.activities.push(
      activity({ activityId: "activity_correct", recordedAt: "2026-08-24T09:00:00.000Z" }),
      activity({ activityId: "activity_keep", recordedAt: "2026-08-24T09:30:00.000Z" }),
      activity({ activityId: "activity_duplicate", recordedAt: "2026-08-24T10:00:00.000Z" }),
    );

    await expectActivityMutationResultContract(createInMemoryActivityMutationStore(state), {
      correction: {
        ...scope,
        sourceMessageId: "message_correction_contract",
        handle: "activity_correct",
        expectedRevision: 1,
        mode: "patch",
        routinePattern: "waiting_for_input",
        recordedAfter: "2026-08-23T12:00:00.000Z",
        recordedBefore: now,
        changedAt: now,
      },
      supersession: {
        ...scope,
        sourceMessageId: "message_supersession_contract",
        handle: "activity_duplicate",
        expectedRevision: 1,
        replacementHandle: "activity_keep",
        replacementExpectedRevision: 1,
        recordedAfter: "2026-08-23T12:00:00.000Z",
        recordedBefore: now,
        changedAt: now,
      },
    });

    expect(state.activities.find(({ activityId }) => activityId === "activity_correct")?.revisions).toHaveLength(2);
    expect(state.activities.find(({ activityId }) => activityId === "activity_duplicate")?.revisions).toHaveLength(2);
  });

  it("patches routine fields, explicitly clears routine identity, and records both revision states", async () => {
    const { state, corrections } = service([activity({ routineId: "routine_weekly_report", routineLabel: "Weekly reports", recurrence: "weekly" })]);

    await expect(corrections.correct({ ...scope, sourceMessageId: "message_routine_correction" }, {
      handle: "activity_a", expectedRevision: 1, mode: "patch",
      correction: { routineId: null, routineLabel: "Monthly reports", recurrence: "monthly" },
    })).resolves.toEqual({ status: "completed", handle: "activity_a", revision: 2 });

    expect(state.activities[0]).toMatchObject({ routineLabel: "Monthly reports", recurrence: "monthly", revision: 2 });
    expect(state.activities[0]).not.toHaveProperty("routineId");
    expect(state.activities[0]?.revisions).toEqual([
      expect.objectContaining({ revision: 1, operation: "created", routineId: "routine_weekly_report", routineLabel: "Weekly reports", recurrence: "weekly" }),
      expect.objectContaining({ revision: 2, operation: "corrected", routineLabel: "Monthly reports", recurrence: "monthly" }),
    ]);
    expect(state.activities[0]?.revisions?.[1]).not.toHaveProperty("routineId");
  });

  it("patches a named obstacle on one canonical row, retains initial evidence, and replays idempotently", async () => {
    const { state, corrections } = service([activity()]);
    const command = { handle: "activity_a", expectedRevision: 1, mode: "patch" as const, correction: { routinePattern: "waiting_for_input" as const } };

    await expect(corrections.correct({ ...scope, sourceMessageId: "message_correction" }, command))
      .resolves.toEqual({ status: "completed", handle: "activity_a", revision: 2 });
    await expect(corrections.correct({ ...scope, sourceMessageId: "message_correction" }, command))
      .resolves.toEqual({ status: "completed", handle: "activity_a", revision: 2 });

    expect(state.activities).toHaveLength(1);
    expect(state.activities[0]).toMatchObject({
      activityId: "activity_a", taskCategory: "reporting", routinePattern: "waiting_for_input",
      revision: 2, status: "active", sourceMessageId: "message_original",
      lastCorrectionMessageId: "message_correction",
    });
    expect(state.activities[0]?.revisions).toEqual([
      expect.objectContaining({ revision: 1, operation: "created", routinePattern: "manual_reporting", sourceMessageId: "message_original" }),
      expect.objectContaining({ revision: 2, operation: "corrected", routinePattern: "waiting_for_input", sourceMessageId: "message_correction" }),
    ]);
  });

  it("supports replace correction for a misordered pair and rejects stale, cross-owner, and cross-group handles", async () => {
    const { state, corrections } = service([
      activity({ activityId: "activity_first", taskCategory: "meetings", recordedAt: "2026-08-24T09:00:00.000Z" }),
      activity({ activityId: "activity_second", taskCategory: "reporting", recordedAt: "2026-08-24T10:00:00.000Z" }),
      activity({ activityId: "foreign_owner", employeeId: "employee_b" }),
      activity({ activityId: "foreign_group", groupId: "group_b" }),
    ]);

    await corrections.correct({ ...scope, sourceMessageId: "message_order_fix_1" }, {
      handle: "activity_first", expectedRevision: 1, mode: "replace", correction: { taskCategory: "reporting" },
    });
    await corrections.correct({ ...scope, sourceMessageId: "message_order_fix_2" }, {
      handle: "activity_second", expectedRevision: 1, mode: "replace", correction: { taskCategory: "meetings" },
    });
    expect(state.activities.find(({ activityId }) => activityId === "activity_first")?.taskCategory).toBe("reporting");
    expect(state.activities.find(({ activityId }) => activityId === "activity_second")?.taskCategory).toBe("meetings");
    await expect(corrections.correct({ ...scope, sourceMessageId: "stale" }, {
      handle: "activity_first", expectedRevision: 1, mode: "patch", correction: { system: "spreadsheets" },
    })).rejects.toThrow(conflict);
    await expect(corrections.correct({ ...scope, sourceMessageId: "foreign" }, {
      handle: "foreign_owner", expectedRevision: 1, mode: "patch", correction: { system: "spreadsheets" },
    })).rejects.toThrow(conflict);
    await expect(corrections.correct({ ...scope, sourceMessageId: "foreign" }, {
      handle: "foreign_group", expectedRevision: 1, mode: "patch", correction: { system: "spreadsheets" },
    })).rejects.toThrow(conflict);
  });

  it("rejects correction and supersession when the source message belongs to another employee", async () => {
    const state = createInMemoryActivityCollectionState();
    state.activities.push(
      activity({ activityId: "activity_keep", recordedAt: "2026-08-24T09:00:00.000Z" }),
      activity({ activityId: "activity_duplicate", recordedAt: "2026-08-24T10:00:00.000Z" }),
    );
    const corrections = new ActivityCorrectionService(createInMemoryActivityMutationStore(state, {
      messageOwner: (messageId) => messageId === "message_foreign" ? "employee_b" : undefined,
    }), { now: () => now });

    await expect(corrections.correct({ ...scope, sourceMessageId: "message_foreign" }, {
      handle: "activity_keep", expectedRevision: 1, mode: "patch", correction: { system: "spreadsheets" },
    })).rejects.toThrow(conflict);
    await expect(corrections.supersede({ ...scope, sourceMessageId: "message_foreign" }, {
      handle: "activity_duplicate", expectedRevision: 1, replacementHandle: "activity_keep", replacementExpectedRevision: 1,
    })).rejects.toThrow(conflict);
    expect(state.activities).toEqual([
      activity({ activityId: "activity_keep", recordedAt: "2026-08-24T09:00:00.000Z" }),
      activity({ activityId: "activity_duplicate", recordedAt: "2026-08-24T10:00:00.000Z" }),
    ]);
  });

  it("supersedes a confirmed duplicate idempotently while current reads and reports exclude it", async () => {
    const { state, corrections } = service([
      activity({ activityId: "activity_keep", routineId: "routine_keep", routineLabel: "Keep reports", recurrence: "weekly", recordedAt: "2026-08-24T09:00:00.000Z" }),
      activity({ activityId: "activity_duplicate", routineId: "routine_duplicate", routineLabel: "Duplicate reports", recurrence: "weekly", recordedAt: "2026-08-24T10:00:00.000Z" }),
    ]);
    const input = { handle: "activity_duplicate", expectedRevision: 1, replacementHandle: "activity_keep", replacementExpectedRevision: 1 };
    await corrections.supersede({ ...scope, sourceMessageId: "message_duplicate_confirmed" }, input);
    await corrections.supersede({ ...scope, sourceMessageId: "message_duplicate_confirmed" }, input);

    expect(state.activities).toHaveLength(2);
    expect(state.activities.find(({ activityId }) => activityId === "activity_duplicate")).toMatchObject({
      status: "superseded", supersededByActivityId: "activity_keep", revision: 2,
      lastCorrectionMessageId: "message_duplicate_confirmed", routineId: "routine_duplicate", routineLabel: "Duplicate reports", recurrence: "weekly",
    });
    expect(state.activities.find(({ activityId }) => activityId === "activity_duplicate")?.revisions?.[1]).toMatchObject({
      operation: "superseded", routineId: "routine_duplicate", routineLabel: "Duplicate reports", recurrence: "weekly",
    });
    expect(state.activities.find(({ activityId }) => activityId === "activity_keep")).toMatchObject({
      routineId: "routine_keep", routineLabel: "Keep reports", recurrence: "weekly",
    });
    const recent = new RecentOwnActivitiesService(createInMemoryRecentOwnActivityReadStore(state), { now: () => now });
    await expect(recent.read(scope)).resolves.toEqual({ activities: [expect.objectContaining({ handle: "activity_keep" })] });

    const ownStore = createInMemoryOwnActivityReadStore(state);
    const weekly = await new WeeklyActivitySummaryService(ownStore, { now: () => now }).summarize({ employeeId: scope.employeeId, timezone: "Etc/UTC" });
    const cycle = await new CycleActivitySummaryService(ownStore, { now: () => now }).summarize({ employeeId: scope.employeeId, timezone: "Etc/UTC" });
    expect(weekly.activityCount).toBe(1);
    expect(cycle.activityCount).toBe(1);

    const report = await new CompanyReportingService(createInMemoryCompanyReportStore({ participants: [participant()], activities: state }), () => now)
      .exportGroup({ companyId: scope.companyId, groupId: scope.groupId });
    expect(report.internal.coverage.observations).toBe(1);
    expect(new Set(report.internal.buckets.flatMap(({ evidenceRefs }) => evidenceRefs.map(({ id }) => id))))
      .toEqual(new Set(["activity_keep"]));
  });

  it("keeps ambiguity outside mutation and exposes only opaque revisioned schemas", () => {
    const correctTool = createCorrectRecentActivityTool(
      async () => ({ status: "completed", handle: "opaque", revision: 2 }),
      new RequestDurationEvidence(extractDurationEvidence("Исправление: заняло 35 минут")),
    );
    const supersedeTool = createSupersedeRecentActivityTool(async () => ({ status: "completed", handle: "opaque", revision: 2 }));
    const schemas = JSON.stringify([
      correctTool.inputSchema!["~standard"].jsonSchema.input({ target: "draft-07" }),
      supersedeTool.inputSchema!["~standard"].jsonSchema.input({ target: "draft-07" }),
    ]);
    const process = readFileSync("vault/assistant/processes/evening_reflection.md", "utf8");

    expect(schemas).not.toMatch(/employeeId|subjectKey|companyId|groupId|roleId|messageId|rawText|userText/u);
    expect(process).toContain("Several matches require one short clarification");
    expect(process).toContain("A stale revision changes nothing");
    expect(correctTool.description).toContain("one candidate is unambiguous");
    expect(supersedeTool.description).toContain("Never infer duplicates");
  });

  it("sets duration only through current-message evidence and keeps replace clearing available", async () => {
    const calls: unknown[] = [];
    const evidence = new RequestDurationEvidence(extractDurationEvidence("Исправление: встреча заняла 35 минут"));
    const tool = createCorrectRecentActivityTool(async (input) => {
      calls.push(input);
      return { status: "completed", handle: input.handle, revision: input.expectedRevision + 1 };
    }, evidence);

    await expect(tool.execute?.({
      handle: "activity_a", expectedRevision: 1, mode: "patch",
      correction: { durationRef: "duration_1" } as never,
    }, {} as never)).resolves.toEqual({ status: "completed", handle: "activity_a", revision: 2 });
    expect(calls).toEqual([{
      handle: "activity_a", expectedRevision: 1, mode: "patch",
      correction: { durationBucket: "30_60m" },
    }]);

    const clearing = createCorrectRecentActivityTool(async (input) => {
      calls.push(input);
      return { status: "completed", handle: input.handle, revision: input.expectedRevision + 1 };
    }, new RequestDurationEvidence([]));
    await clearing.execute?.({
      handle: "activity_a", expectedRevision: 2, mode: "replace", correction: { taskCategory: "meetings" } as never,
    }, {} as never);
    expect(calls.at(-1)).toEqual({
      handle: "activity_a", expectedRevision: 2, mode: "replace", correction: { taskCategory: "meetings" },
    });
    const schema = clearing.inputSchema!["~standard"].jsonSchema.input({ target: "draft-07" });
    expect(JSON.stringify(schema)).not.toContain("durationBucket");
  });
});
