import { describe, expect, it } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { CollectActivityService } from "../../../src/application/activity-collection.js";
import {
  createInMemoryActivityCollectionState,
  createInMemoryActivityCollectionStore,
  createInMemoryOwnActivityReadStore,
} from "../../../src/application/in-memory-activity-collection-store.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryFeedbackStore } from "../../../src/application/in-memory-feedback-store.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";
import { createInMemoryInsightStore } from "../../../src/application/in-memory-insight-store.js";
import { createInMemoryProfileStore } from "../../../src/application/in-memory-profile-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { createRuntimeProjectionBuilder } from "../../../src/application/runtime-projections/runtime-projection-builder.js";
import { WeeklyActivitySummaryService } from "../../../src/application/weekly-activity-summary.js";

// Friday of the pilot week; the window covers the previous Saturday through today.
const friday = "2026-08-21T14:00:00.000Z";

function harness(runner: ConstructorParameters<typeof AssistantService>[0]) {
  const clock = { now: () => friday };
  const world = createInMemoryWorld(clock.now);
  for (const employeeId of ["employee_a", "employee_b"]) {
    world.participants.push({
      employeeId, companyId: "company_a", groupId: "group_a", subjectKey: `subject_${employeeId}`,
      roleId: "role_a", status: "profile_completed", createdAt: clock.now(), updatedAt: clock.now(),
    });
    world.profiles.push({
      employeeId, companyId: "company_a", groupId: "group_a", roleId: "role_a",
      preferredName: employeeId, assistantName: "Assistant", addressForm: "informal", persona: "efficiency",
      responseLength: "short", timezone: "Europe/Moscow", createdAt: clock.now(), updatedAt: clock.now(),
    });
  }
  const documents = createInMemoryDocumentStore(clock);
  const ideas = createInMemoryIdeaStore(clock);
  const conversationStore = createInMemoryConversationStore(world);
  const state = createInMemoryActivityCollectionState();
  const activities = new CollectActivityService(createInMemoryActivityCollectionStore(state), clock, (() => {
    let index = 0;
    return () => `activity_${++index}`;
  })());
  const weekly = new WeeklyActivitySummaryService(createInMemoryOwnActivityReadStore(state), clock);
  const profiles = createInMemoryProfileStore(world);
  const service = new AssistantService(runner, {
    documentStore: documents,
    conversationStore,
    ideaStore: ideas,
    ingestionService: createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock), ideaStore: ideas }),
    participantStore: profiles,
    chatProjectionBuilder: createRuntimeProjectionBuilder({
      profileStore: profiles,
      conversationStore,
      insightStore: createInMemoryInsightStore(world),
      feedbackStore: createInMemoryFeedbackStore(world),
      auditEventStore: createInMemoryAuditEventStore(world),
      clock,
    }),
    collectActivities: (command) => activities.collectBatch(command),
    readWeeklyActivities: (input) => weekly.summarize(input),
    requestIntegrityGuard: async () => ({ status: "allowed" }),
    clock,
  });
  return { service, state, weekly, world };
}

function record(input: {
  employeeId: string;
  activityDate: string;
  taskCategory?: "reporting" | "meetings" | "coordination";
  obstacle?: { kind: "routine_pattern"; value: "manual_reporting" } | { kind: "energy_stress_marker"; value: "fatigue" };
  durationBucket?: "1_2h";
}) {
  return {
    activityId: `activity_${input.employeeId}_${input.activityDate}_${input.taskCategory ?? "none"}`,
    employeeId: input.employeeId,
    subjectKey: `subject_${input.employeeId}`,
    companyId: "company_a",
    groupId: "group_a",
    roleId: "role_a",
    ...(input.taskCategory === undefined ? {} : { taskCategory: input.taskCategory }),
    ...(input.obstacle === undefined ? {} : { obstacle: input.obstacle }),
    ...(input.durationBucket === undefined ? {} : { durationBucket: input.durationBucket }),
    activityDate: input.activityDate,
    recordedAt: friday,
  };
}

describe("SPEC-MINUTKA-WEEKLY-SUMMARY-001: personal weekly checkpoint", () => {
  it("counts only the employee's own activities inside the seven local days", async () => {
    const { state, weekly } = harness(async () => "unused");
    state.activities.push(
      record({ employeeId: "employee_a", activityDate: "2026-08-14" }),
      record({ employeeId: "employee_a", activityDate: "2026-08-17", taskCategory: "reporting", obstacle: { kind: "routine_pattern", value: "manual_reporting" } }),
      record({ employeeId: "employee_a", activityDate: "2026-08-18", taskCategory: "reporting", durationBucket: "1_2h" }),
      record({ employeeId: "employee_a", activityDate: "2026-08-20", taskCategory: "meetings", obstacle: { kind: "energy_stress_marker", value: "fatigue" } }),
      record({ employeeId: "employee_b", activityDate: "2026-08-20", taskCategory: "coordination" }),
    );

    await expect(weekly.summarize({ employeeId: "employee_a", timezone: "Europe/Moscow" })).resolves.toEqual({
      fromDate: "2026-08-15",
      toDate: "2026-08-21",
      activityCount: 3,
      activeDates: 3,
      sufficientData: true,
      taskCategories: [{ value: "reporting", count: 2 }, { value: "meetings", count: 1 }],
      routinePatterns: [{ value: "manual_reporting", count: 1 }],
      automationCandidates: [],
      energyStressMarkers: [{ value: "fatigue", count: 1 }],
      durationBuckets: [{ value: "1_2h", count: 1 }],
      systems: [],
    });
    await expect(weekly.summarize({ employeeId: "employee_b", timezone: "Europe/Moscow" })).resolves.toMatchObject({
      activityCount: 1,
      taskCategories: [{ value: "coordination", count: 1 }],
    });
  });

  it("anchors the seven local days on the profile day, not on the UTC one", async () => {
    const state = createInMemoryActivityCollectionState();
    // 00:30 Moscow on 2026-08-21: the local window is 08-15..08-21, while a
    // UTC-dated clock would read 08-14..08-20 and swap both edge activities.
    const weekly = new WeeklyActivitySummaryService(
      createInMemoryOwnActivityReadStore(state),
      { now: () => "2026-08-20T21:30:00.000Z" },
    );
    state.activities.push(
      record({ employeeId: "employee_a", activityDate: "2026-08-14", taskCategory: "meetings" }),
      record({ employeeId: "employee_a", activityDate: "2026-08-21", taskCategory: "reporting" }),
    );

    await expect(weekly.summarize({ employeeId: "employee_a", timezone: "Europe/Moscow" })).resolves.toMatchObject({
      fromDate: "2026-08-15",
      toDate: "2026-08-21",
      activityCount: 1,
      taskCategories: [{ value: "reporting", count: 1 }],
    });
  });

  it("marks a thin week as insufficient instead of naming a pattern", async () => {
    const { state, weekly } = harness(async () => "unused");
    state.activities.push(
      record({ employeeId: "employee_a", activityDate: "2026-08-20", taskCategory: "reporting" }),
      record({ employeeId: "employee_a", activityDate: "2026-08-20", taskCategory: "meetings" }),
    );

    await expect(weekly.summarize({ employeeId: "employee_a", timezone: "Europe/Moscow" })).resolves.toMatchObject({
      activityCount: 2,
      activeDates: 1,
      sufficientData: false,
    });
    await expect(weekly.summarize({ employeeId: "employee_b", timezone: "Europe/Moscow" })).resolves.toMatchObject({
      activityCount: 0,
      activeDates: 0,
      sufficientData: false,
      taskCategories: [],
    });
  });

  it("answers the scheduled weekly touch from the typed read without writing anything", async () => {
    let seen: Awaited<ReturnType<WeeklyActivitySummaryService["summarize"]>> | undefined;
    const { service, state } = harness(async (_input, context) => {
      context.markProcessUsed("weekly_summary");
      seen = await context.readWeeklyActivities();
      return `За неделю: отчёты — ${seen.taskCategories[0]?.count ?? 0}. Похоже на правду?`;
    });
    state.activities.push(
      record({ employeeId: "employee_a", activityDate: "2026-08-17", taskCategory: "reporting" }),
      record({ employeeId: "employee_a", activityDate: "2026-08-18", taskCategory: "reporting" }),
      record({ employeeId: "employee_a", activityDate: "2026-08-19", taskCategory: "reporting" }),
      record({ employeeId: "employee_b", activityDate: "2026-08-19", taskCategory: "meetings" }),
    );

    const result = await service.chat({
      userId: "employee_a", threadId: "weekly", text: "Недельное сообщение", requiredProcessId: "weekly_summary",
    });

    expect(result.selectedProcessIds).toEqual(["core", "weekly_summary"]);
    expect(result.effect).toBe("none");
    expect(seen).toMatchObject({ activityCount: 3, sufficientData: true, taskCategories: [{ value: "reporting", count: 3 }] });
    expect(result.response).toContain("отчёты — 3");
    expect(state.activities).toHaveLength(4);
  });

  it("changes personal context only after the employee confirms the pattern", async () => {
    const { service, state, world } = harness(async (input, context) => {
      context.markProcessUsed("weekly_summary");
      await context.readWeeklyActivities();
      if (input.text.startsWith("Да,")) {
        await context.updatePersonalContext({ typicalTasks: ["еженедельный отчёт"] });
        return "Записал: еженедельный отчёт.";
      }
      return "Похоже, отчёт повторялся. Подтвердите или поправьте.";
    });
    state.activities.push(
      record({ employeeId: "employee_a", activityDate: "2026-08-17", taskCategory: "reporting" }),
      record({ employeeId: "employee_a", activityDate: "2026-08-18", taskCategory: "reporting" }),
      record({ employeeId: "employee_a", activityDate: "2026-08-19", taskCategory: "reporting" }),
    );

    const noticed = await service.chat({
      userId: "employee_a", threadId: "weekly", text: "Недельное сообщение", requiredProcessId: "weekly_summary",
    });
    expect(noticed.effect).toBe("none");
    expect(world.profiles.find((profile) => profile.employeeId === "employee_a")?.typicalTasks).toBeUndefined();

    const confirmed = await service.chat({
      userId: "employee_a", threadId: "weekly", text: "Да, отчёт каждую неделю", requiredProcessId: "weekly_summary",
    });
    expect(confirmed.effect).toBe("business_write_committed");
    expect(world.profiles.find((profile) => profile.employeeId === "employee_a")?.typicalTasks).toEqual(["еженедельный отчёт"]);
  });
});
