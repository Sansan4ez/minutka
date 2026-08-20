import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { CollectActivityService } from "../../../src/application/activity-collection.js";
import { CycleActivitySummaryService } from "../../../src/application/cycle-activity-summary.js";
import { FinalReportArmingService, finalReportArmingConfirmation } from "../../../src/application/final-report-arming.js";
import { ScheduleManagementService } from "../../../src/application/schedule-management-service.js";
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
import { createInMemoryScheduleStore } from "../../../src/application/in-memory-schedule-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { createRuntimeProjectionBuilder } from "../../../src/application/runtime-projections/runtime-projection-builder.js";
import { ownerManagedScheduledProcessIds } from "../../../src/domain/assistant-process.js";
import { runArmFinalReportsCommand } from "../../../src/runtime/arm-final-reports-command.js";

// Last day of the two-week cycle; the window covers the previous 13 days too.
const lastCycleDay = "2026-08-28T14:00:00.000Z";

function harness(runner: ConstructorParameters<typeof AssistantService>[0]) {
  const clock = { now: () => lastCycleDay };
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
  const cycle = new CycleActivitySummaryService(createInMemoryOwnActivityReadStore(state), clock);
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
    readCycleActivities: (input) => cycle.summarize(input),
    requestIntegrityGuard: async () => ({ status: "allowed" }),
    clock,
  });
  return { service, state, cycle, world, clock, profiles };
}

function record(input: {
  employeeId: string;
  activityDate: string;
  taskCategory?: "reporting" | "meetings" | "coordination";
  obstacle?:
    | { kind: "routine_pattern"; value: "manual_reporting" }
    | { kind: "automation_candidate"; value: "report_generation" }
    | { kind: "energy_stress_marker"; value: "fatigue" };
  system?: "spreadsheets";
}) {
  return {
    activityId: `activity_${input.employeeId}_${input.activityDate}_${input.taskCategory ?? "none"}_${input.obstacle?.value ?? "none"}`,
    employeeId: input.employeeId,
    subjectKey: `subject_${input.employeeId}`,
    companyId: "company_a",
    groupId: "group_a",
    roleId: "role_a",
    ...(input.taskCategory === undefined ? {} : { taskCategory: input.taskCategory }),
    ...(input.obstacle === undefined ? {} : { obstacle: input.obstacle }),
    ...(input.system === undefined ? {} : { system: input.system }),
    activityDate: input.activityDate,
    recordedAt: lastCycleDay,
  };
}

/** A cycle with a repeated reporting routine, one meeting, and one energy marker. */
function twoWeekCycle(employeeId = "employee_a") {
  return [
    record({ employeeId, activityDate: "2026-08-15", taskCategory: "reporting", obstacle: { kind: "routine_pattern", value: "manual_reporting" }, system: "spreadsheets" }),
    record({ employeeId, activityDate: "2026-08-18", taskCategory: "reporting", obstacle: { kind: "automation_candidate", value: "report_generation" }, system: "spreadsheets" }),
    record({ employeeId, activityDate: "2026-08-21", taskCategory: "reporting", obstacle: { kind: "routine_pattern", value: "manual_reporting" } }),
    record({ employeeId, activityDate: "2026-08-25", taskCategory: "meetings", obstacle: { kind: "energy_stress_marker", value: "fatigue" } }),
    record({ employeeId, activityDate: "2026-08-27", taskCategory: "reporting" }),
    record({ employeeId, activityDate: "2026-08-28", taskCategory: "reporting" }),
  ];
}

describe("SPEC-MINUTKA-FINAL-REPORT-001: final personal report of the two-week cycle", () => {
  it("counts only the employee's own activities inside the fourteen local days", async () => {
    const { state, cycle } = harness(async () => "unused");
    state.activities.push(
      // The day before the cycle: outside the horizon and outside the report.
      record({ employeeId: "employee_a", activityDate: "2026-08-14", taskCategory: "coordination" }),
      ...twoWeekCycle(),
      record({ employeeId: "employee_b", activityDate: "2026-08-26", taskCategory: "coordination" }),
    );

    const summary = await cycle.summarize({ employeeId: "employee_a", timezone: "Europe/Moscow" });
    expect(summary).toMatchObject({
      fromDate: "2026-08-15",
      toDate: "2026-08-28",
      activityCount: 6,
      activeDates: 6,
      sufficientData: true,
      patternMinimumCount: 2,
      taskCategories: [{ value: "reporting", count: 5 }, { value: "meetings", count: 1 }],
      routinePatterns: [{ value: "manual_reporting", count: 2 }],
      automationCandidates: [{ value: "report_generation", count: 1 }],
      energyStressMarkers: [{ value: "fatigue", count: 1 }],
      systems: [{ value: "spreadsheets", count: 2 }],
    });
    // The employee's own coordination day sits before the window; another
    // participant's row never reaches the report at all.
    expect(summary.taskCategories.some(({ value }) => value === "coordination")).toBe(false);
    await expect(cycle.summarize({ employeeId: "employee_b", timezone: "Europe/Moscow" })).resolves.toMatchObject({
      activityCount: 1,
      taskCategories: [{ value: "coordination", count: 1 }],
    });
  });

  it("anchors the fourteen local days on the profile day, not on the UTC one", async () => {
    const state = createInMemoryActivityCollectionState();
    // 00:30 Moscow on 2026-08-28: the local window is 08-15..08-28, while a
    // UTC-dated clock would read 08-14..08-27 and swap both edge activities.
    const cycle = new CycleActivitySummaryService(
      createInMemoryOwnActivityReadStore(state),
      { now: () => "2026-08-27T21:30:00.000Z" },
    );
    state.activities.push(
      record({ employeeId: "employee_a", activityDate: "2026-08-14", taskCategory: "meetings" }),
      record({ employeeId: "employee_a", activityDate: "2026-08-28", taskCategory: "reporting" }),
    );

    await expect(cycle.summarize({ employeeId: "employee_a", timezone: "Europe/Moscow" })).resolves.toMatchObject({
      fromDate: "2026-08-15",
      toDate: "2026-08-28",
      activityCount: 1,
      taskCategories: [{ value: "reporting", count: 1 }],
    });
  });

  it("confirms as a pattern only what repeated inside the cycle", async () => {
    const { state, cycle } = harness(async () => "unused");
    state.activities.push(...twoWeekCycle(), record({ employeeId: "employee_a", activityDate: "2026-08-24", taskCategory: "meetings" }));

    await expect(cycle.summarize({ employeeId: "employee_a", timezone: "Europe/Moscow" })).resolves.toMatchObject({
      activityCount: 7,
      activeDates: 7,
      sufficientData: true,
      confirmedPatterns: {
        taskCategories: ["reporting", "meetings"],
        routinePatterns: ["manual_reporting"],
        // Named once over two weeks: an episode, not a pattern.
        automationCandidates: [],
        energyStressMarkers: [],
        systems: ["spreadsheets"],
      },
    });
  });

  it("marks a thin cycle as insufficient instead of describing two weeks", async () => {
    const { state, cycle } = harness(async () => "unused");
    state.activities.push(
      record({ employeeId: "employee_a", activityDate: "2026-08-27", taskCategory: "reporting" }),
      record({ employeeId: "employee_a", activityDate: "2026-08-28", taskCategory: "meetings" }),
    );

    await expect(cycle.summarize({ employeeId: "employee_a", timezone: "Europe/Moscow" })).resolves.toMatchObject({
      activityCount: 2, activeDates: 2, sufficientData: false,
    });
    await expect(cycle.summarize({ employeeId: "employee_b", timezone: "Europe/Moscow" })).resolves.toMatchObject({
      activityCount: 0, activeDates: 0, sufficientData: false, taskCategories: [],
      confirmedPatterns: { taskCategories: [], routinePatterns: [], automationCandidates: [], energyStressMarkers: [], systems: [] },
    });
  });

  it("answers the final touch from the typed read and records nothing", async () => {
    let seen: Awaited<ReturnType<CycleActivitySummaryService["summarize"]>> | undefined;
    const { service, state, world } = harness(async (_input, context) => {
      context.markProcessUsed("final_report");
      seen = await context.readCycleActivities();
      return `За две недели повторялось: ${seen.confirmedPatterns.taskCategories.join(", ")}. Шаг: соберите отчёт по шаблону.`;
    });
    state.activities.push(...twoWeekCycle(), record({ employeeId: "employee_b", activityDate: "2026-08-26", taskCategory: "coordination" }));
    const activitiesBefore = state.activities.length;

    const result = await service.chat({
      userId: "employee_a", threadId: "cycle", text: "Итог цикла", requiredProcessId: "final_report",
    });

    expect(result.selectedProcessIds).toEqual(["core", "final_report"]);
    expect(result.effect).toBe("none");
    expect(seen).toMatchObject({ activityCount: 6, sufficientData: true });
    expect(result.response).toContain("reporting");
    // Neither the corpus nor the personal profile changes because of the report.
    expect(state.activities).toHaveLength(activitiesBefore);
    expect(world.profiles.find((profile) => profile.employeeId === "employee_a")?.typicalTasks).toBeUndefined();
  });

  it("arms one non-recurring report per onboarded participant of the group", async () => {
    const { world, clock, profiles } = harness(async () => "unused");
    world.participants.push({
      employeeId: "employee_onboarding", companyId: "company_a", groupId: "group_a", subjectKey: "subject_onboarding",
      roleId: "role_a", status: "invite_opened", createdAt: clock.now(), updatedAt: clock.now(),
    });
    world.participants.push({
      employeeId: "employee_other_group", companyId: "company_a", groupId: "group_b", subjectKey: "subject_other",
      roleId: "role_a", status: "profile_completed", createdAt: clock.now(), updatedAt: clock.now(),
    });
    world.profiles.push({
      employeeId: "employee_other_group", companyId: "company_a", groupId: "group_b", roleId: "role_a",
      preferredName: "Другая группа", assistantName: "Assistant", addressForm: "informal", persona: "efficiency",
      responseLength: "short", timezone: "Europe/Moscow", createdAt: clock.now(), updatedAt: clock.now(),
    });
    const scheduleStore = createInMemoryScheduleStore(clock);
    const schedules = new ScheduleManagementService(scheduleStore, profiles, clock);
    const arming = new FinalReportArmingService(profiles, schedules);
    const scope = { companyId: "company_a", groupId: "group_a" };

    await expect(arming.preview({ ...scope, timeOfDay: "17:00" })).resolves.toEqual({
      ...scope,
      timeOfDay: "17:00",
      eligible: 2,
      notOnboarded: 1,
      confirmation: "SEND FINAL REPORT company_a/group_a",
    });
    expect(finalReportArmingConfirmation(scope)).toBe("SEND FINAL REPORT company_a/group_a");

    const armed = await arming.arm({ ...scope, timeOfDay: "17:00" });
    expect(armed).toMatchObject({ armed: 2, failed: 0 });
    expect(armed.outcomes.map(({ employeeId }) => employeeId)).toEqual(["employee_a", "employee_b"]);
    const schedule = await scheduleStore.get("employee_a", "employee_a:final_report-daily");
    expect(schedule).toMatchObject({
      kind: "process", processId: "final_report", oneShot: true, enabled: true,
      timeOfDay: "17:00", timezone: "Europe/Moscow", daysOfWeek: 127,
    });
    // Another group of the same company is a separate cycle and is untouched.
    await expect(scheduleStore.list("employee_other_group")).resolves.toEqual([]);
    // Rerunning the same end of cycle re-arms the same row instead of adding a second one.
    await expect(arming.arm({ ...scope, timeOfDay: "18:30" })).resolves.toMatchObject({ armed: 2, failed: 0 });
    await expect(scheduleStore.list("employee_a")).resolves.toHaveLength(1);
    await expect(scheduleStore.get("employee_a", "employee_a:final_report-daily")).resolves.toMatchObject({ timeOfDay: "18:30" });
  });

  it("keeps the operator-armed report out of the employee's own schedule settings", async () => {
    const { world, clock, profiles } = harness(async () => "unused");
    const scheduleStore = createInMemoryScheduleStore(clock);
    const schedules = new ScheduleManagementService(scheduleStore, profiles, clock);
    await new FinalReportArmingService(profiles, schedules).arm({ companyId: "company_a", groupId: "group_a", timeOfDay: "17:00" });
    await schedules.saveDailySchedule("employee_a", { processId: "evening_reflection", timeOfDay: "19:00" });

    await expect(schedules.listSchedules("employee_a")).resolves.toMatchObject([{ processId: "evening_reflection" }]);
    expect(ownerManagedScheduledProcessIds).not.toContain("final_report");
    expect(world.profiles.find((profile) => profile.employeeId === "employee_a")?.timezone).toBe("Europe/Moscow");
  });

  it("arms only after the exact typed confirmation and never on preview", async () => {
    const { clock, profiles } = harness(async () => "unused");
    const scheduleStore = createInMemoryScheduleStore(clock);
    const service = new FinalReportArmingService(profiles, new ScheduleManagementService(scheduleStore, profiles, clock));
    const output: string[] = [];
    const run = (argv: string[], confirmation: string) => runArmFinalReportsCommand(argv, {
      service,
      readConfirmation: async () => confirmation,
      write: (text) => output.push(text),
    });

    await run(["--company", "company_a", "--group", "group_a", "--preview"], "SEND FINAL REPORT company_a/group_a");
    expect(output.join("")).toContain('"confirmation": "SEND FINAL REPORT company_a/group_a"');
    // The default local time is inside the working day.
    expect(output.join("")).toContain('"timeOfDay": "17:00"');
    await expect(scheduleStore.list("employee_a")).resolves.toEqual([]);

    await expect(run(["--company", "company_a", "--group", "group_a"], "SEND FINAL REPORT company_a/group_b"))
      .rejects.toThrow("confirmation did not match; nothing was armed");
    await expect(scheduleStore.list("employee_a")).resolves.toEqual([]);

    await expect(run(["--company", "company_a", "--group", "group_missing"], "SEND FINAL REPORT company_a/group_missing"))
      .rejects.toThrow("no onboarded participant in this group; nothing was armed");

    await run(["--company", "company_a", "--group", "group_a"], " SEND FINAL REPORT company_a/group_a ");
    await expect(scheduleStore.list("employee_a")).resolves.toMatchObject([{ processId: "final_report", oneShot: true }]);
  });

  it("separates the personal report from the company artifact and its retention", () => {
    const runbook = readFileSync("docs/runbooks/end-of-cycle.md", "utf8");
    expect(runbook).toContain("npm run cycle:final-reports");
    expect(runbook).toContain("SEND FINAL REPORT");
    expect(runbook).toContain("Личный отчёт не входит в артефакт компании");
    expect(runbook).toContain("удаление обезличенного среза компании его не затрагивает");
    expect(runbook).toContain("данных за цикл мало");
    const skillsMap = readFileSync("docs/product/skills-map.md", "utf8");
    expect(skillsMap).toContain("final_report");
    expect(skillsMap).toContain("readCycleActivities");
    const process = readFileSync("vault/assistant/processes/final_report.md", "utf8");
    expect(process).toContain("read-only");
    expect(process).toContain("does not reach the methodologist or the company");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> };
    expect(packageJson.scripts["cycle:final-reports"]).toBe("tsx src/runtime/arm-final-reports.ts");
    expect(runbook).toContain("confirmation did not match; nothing was armed");
    expect(readFileSync("docs/runbooks/company-report-export.md", "utf8")).toContain("end-of-cycle.md");
    expect(readFileSync("docs/runbooks/scheduled-process-on-demand.md", "utf8")).toContain("--process final_report");
  });
});
