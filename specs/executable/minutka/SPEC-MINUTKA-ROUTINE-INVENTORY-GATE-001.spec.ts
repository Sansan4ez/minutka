import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CollectActivityService } from "../../../src/application/activity-collection.js";
import { ClientReportPublishingService } from "../../../src/application/client-report-publishing.js";
import { CycleActivitySummaryService } from "../../../src/application/cycle-activity-summary.js";
import { createInMemoryActivityCollectionState, createInMemoryActivityCollectionStore } from "../../../src/application/in-memory-activity-collection-store.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createInMemoryCompanyReportStore } from "../../../src/application/in-memory-company-report-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { CompanyReportingService } from "../../../src/application/company-reporting.js";
import { createDeterministicIdGenerator } from "../../../src/application/runtime-primitives.js";
import { createActivityTransactionExtractor } from "../../../src/application/activity-transaction-extractor.js";
import { loadRoutineDirectory } from "../../../src/application/routine-directory.js";
import { buildActivityTransactionPrompt } from "../../../src/mastra/activity-transaction-extractor.js";
import { planDirectoryPurge } from "../../../src/application/routine-directory-purge.js";
import { runRoutineDirectoryPurge } from "../../../src/runtime/routine-directory-purge-command.js";
import { loadRoutineDirectoryProviderFromDirectory } from "../../../src/infrastructure/routine-directory-provider.js";

const directory = {
  schemaVersion: "minutka-routine-directory/v1",
  companyId: "company_gate",
  version: "gate-1",
  sections: [{
    roleId: "role_sales",
    entries: [{
      id: "routine_weekly_report",
      name: "Подготовка еженедельных отчётов",
      description: "Подготовка отчётов для рабочего цикла",
      examples: ["Подготовить еженедельный отчёт"],
      quickWin: "report_template",
      provenance: [{ groupId: "group_gate", subjectKey: "subject_a" }],
    }],
  }],
} as const;

type MutableClock = { current: string; now: () => string };

function gateDirectory() {
  return loadRoutineDirectory(directory, { expectedCompanyId: "company_gate" });
}

function createHarness() {
  const clock: MutableClock = { current: "2026-09-01T10:00:00.000Z", now() { return this.current; } };
  const state = createInMemoryActivityCollectionState();
  let activityIndex = 0;
  const activities = new CollectActivityService(
    createInMemoryActivityCollectionStore(state),
    clock,
    () => `activity_gate_${++activityIndex}`,
  );
  let generation = 0;
  const extractor = createActivityTransactionExtractor(async ({ prompt }) => {
    generation += 1;
    const isNamed = generation === 1;
    const patch = {
      taskCategory: "reporting",
      routinePattern: null,
      automationCandidate: null,
      energyStressMarker: null,
      system: "spreadsheets",
      routineId: isNamed ? "routine_weekly_report" : null,
      routineLabel: isNamed ? null : "Согласование заявок",
      recurrence: isNamed ? "weekly" : null,
      durationRef: isNamed ? "named_duration" : "free_duration",
    };
    expect(prompt).toContain("# Routine directory section");
    expect(prompt).toContain("routine_weekly_report");
    return {
      object: {
        kind: "collect",
        reason: null,
        activities: [patch],
        handle: null,
        expectedRevision: null,
        correctionMode: null,
        correction: null,
        replacementHandle: null,
        replacementExpectedRevision: null,
      },
      usage: { inputTokens: 10, outputTokens: 6, totalTokens: 16 },
    };
  }, buildActivityTransactionPrompt);
  const participants = [
    { employeeId: "employee_a", companyId: "company_gate", groupId: "group_gate", subjectKey: "subject_a", roleId: "role_sales", status: "profile_completed" as const, createdAt: clock.current, updatedAt: clock.current },
    { employeeId: "employee_b", companyId: "company_gate", groupId: "group_gate", subjectKey: "subject_b", roleId: "role_sales", status: "profile_completed" as const, createdAt: clock.current, updatedAt: clock.current },
  ];
  const reporting = new CompanyReportingService(
    createInMemoryCompanyReportStore({ participants, activities: state }),
    clock.now,
  );
  const world = createInMemoryWorld(clock.now);
  const audit = createInMemoryAuditEventStore(world);
  const publishing = new ClientReportPublishingService(reporting, audit, clock, createDeterministicIdGenerator());
  const cycle = new CycleActivitySummaryService({
    async listOwnActivities({ employeeId, fromDate, toDate }) {
      return state.activities
        .filter((activity) => activity.employeeId === employeeId && activity.activityDate >= fromDate && activity.activityDate <= toDate)
        .map((activity) => ({ employeeId: activity.employeeId, routineId: activity.routineId, routineLabel: activity.routineLabel, recurrence: activity.recurrence, activityDate: activity.activityDate }));
    },
  }, clock);
  return { clock, state, activities, extractor, reporting, publishing, cycle, participants, audit };
}

async function recordExtractedActivity(
  harness: ReturnType<typeof createHarness>,
  input: { employeeId: string; subjectKey: string; text: string },
) {
  const result = await harness.extractor({
    mode: "record",
    currentText: input.text,
    durationReferences: [
      { ref: harness.state.activities.length === 0 ? "named_duration" : "free_duration", bucket: harness.state.activities.length === 0 ? "30_60m" : "2_4h", sourceOrder: 0 },
    ],
    directorySection: {
      version: "gate-1",
      entries: gateDirectory().sections[0]!.entries.map(({ id, name, description, examples }) => ({ id, name, description, examples })),
    },
  });
  expect(result.status).toBe("completed");
  if (result.status !== "completed" || result.decision.kind !== "collect") throw new Error("mock extractor did not collect");
  const collected = await harness.activities.collectBatch({
    employeeId: input.employeeId,
    subjectKey: input.subjectKey,
    sourceMessageId: `message_${input.employeeId}_${harness.state.activities.length + 1}`,
    companyId: "company_gate",
    groupId: "group_gate",
    roleId: "role_sales",
    timezone: "Etc/UTC",
    activities: result.decision.activities.map(({ durationRef: _durationRef, routineId, routineLabel, recurrence, ...activity }) => ({
      ...activity,
      ...(routineId === undefined || routineId === null ? {} : { routineId }),
      ...(routineLabel === undefined || routineLabel === null ? {} : { routineLabel }),
      ...(recurrence === undefined || recurrence === null ? {} : { recurrence }),
      durationBucket: input.text.includes("еженедельный") ? "30_60m" as const : "2_4h" as const,
    })),
  });
  expect(collected).toMatchObject({ status: "completed", savedCount: 1 });
}

describe("SPEC-MINUTKA-ROUTINE-INVENTORY-GATE-001: end-to-end routine inventory gate", () => {
  it("passes extractor → typed activity → v2 report → preflight → publish → personal read", async () => {
    const harness = createHarness();
    await recordExtractedActivity(harness, { employeeId: "employee_a", subjectKey: "subject_a", text: "Подготовил еженедельный отчёт" });
    harness.clock.current = "2026-09-02T10:00:00.000Z";
    await recordExtractedActivity(harness, { employeeId: "employee_b", subjectKey: "subject_b", text: "Согласовал заявки" });

    for (const [date, employeeId, subjectKey] of [
      ["2026-09-02T10:00:00.000Z", "employee_a", "subject_a"],
      ["2026-09-03T10:00:00.000Z", "employee_a", "subject_a"],
      ["2026-09-04T10:00:00.000Z", "employee_a", "subject_a"],
      ["2026-09-04T11:00:00.000Z", "employee_a", "subject_a"],
      ["2026-09-04T12:00:00.000Z", "employee_a", "subject_a"],
    ] as const) {
      harness.clock.current = date;
      await harness.activities.collect({
        employeeId,
        subjectKey,
        sourceMessageId: `message_extra_${harness.state.activities.length}`,
        companyId: "company_gate",
        groupId: "group_gate",
        roleId: "role_sales",
        timezone: "Etc/UTC",
        activity: { taskCategory: "reporting", routineId: "routine_weekly_report", routineLabel: "Еженедельные отчёты", durationBucket: "30_60m" },
      });
    }

    const report = await harness.reporting.buildReport({ companyId: "company_gate", groupId: "group_gate", directory: gateDirectory() });
    expect(report.internal.schemaVersion).toBe("minutka-internal-report/v2");
    expect(report.internal.timeBudget.length).toBeGreaterThan(0);
    expect(report.internal.routines).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: { roleId: "role_sales", routineId: "routine_weekly_report" }, name: "Подготовка еженедельных отчётов" }),
      expect.objectContaining({ key: { roleId: "role_sales", routineKey: "согласование заявок" } }),
    ]));
    const unnamed = report.internal.preflightFindings.find((finding) => finding.rule === "unnamed_routine");
    expect(unnamed).toMatchObject({ severity: "high", field: "policy" });
    expect(report.internal.preflightFindings).toContainEqual(expect.objectContaining({ id: unnamed?.id }));
    expect(report.client.schemaVersion).toBe("minutka-client-report.v2");
    const clientJson = JSON.stringify(report.client);
    for (const forbidden of ["subject_a", "subject_b", "employee_a", "employee_b", "routineId", "routineKey", "routineLabel", "variants", "evidenceRefs", "sourceMessageId"]) {
      expect(clientJson).not.toContain(forbidden);
    }

    const refused = await harness.publishing.publishClientReport({ companyId: "company_gate", groupId: "group_gate", directory: gateDirectory() });
    expect(refused).toEqual({ ok: false, reason: "unresolved_high_findings", findingIds: [unnamed!.id] });
    await harness.publishing.resolvePreflightFinding({ companyId: "company_gate", groupId: "group_gate", findingId: unnamed!.id, decision: "fixed", directory: gateDirectory() });
    const published = await harness.publishing.publishClientReport({ companyId: "company_gate", groupId: "group_gate", directory: gateDirectory() });
    expect(published).toMatchObject({ ok: true, client: { schemaVersion: "minutka-client-report.v2" }, reportVersion: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(harness.audit).not.toContainEqual(expect.objectContaining({ metadata: expect.objectContaining({ payload: expect.anything() }) }));

    const personal = await harness.cycle.summarize({ employeeId: "employee_a", timezone: "Etc/UTC" });
    expect(personal.routines).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Еженедельные отчёты" })]));
    expect(personal.routines).not.toContainEqual(expect.objectContaining({ label: "Согласование заявок" }));
    expect(JSON.stringify(personal)).not.toContain("subject_b");
  });

  it("recomputes a dangling routine id after subject purge without deleting canonical activity", async () => {
    const harness = createHarness();
    harness.clock.current = "2026-09-04T10:00:00.000Z";
    await harness.activities.collect({
      employeeId: "employee_a", subjectKey: "subject_a", sourceMessageId: "message_shared", companyId: "company_gate", groupId: "group_gate", roleId: "role_sales", timezone: "Etc/UTC",
      activity: { taskCategory: "reporting", routineId: "shared_routine", routineLabel: "Общая сверка", durationBucket: "30_60m" },
    });

    const tempDirectory = await mkdtemp(join(tmpdir(), "minutka-routine-inventory-gate-"));
    const sharedDirectory = {
      ...directory,
      version: "1",
      sections: [{
        roleId: "role_sales",
        entries: [{ ...directory.sections[0]!.entries[0]!, id: "shared_routine", provenance: [{ groupId: "group_gate", subjectKey: "subject_a" }, { groupId: "group_gate", subjectKey: "subject_b" }] }, {
          id: "survivor", name: "Проверка остатков", description: "Проверка остатков", examples: ["Проверить остатки"], quickWin: "checklist", provenance: [{ groupId: "group_gate", subjectKey: "subject_b" }],
        }],
      }],
    };
    await writeFile(join(tempDirectory, "routine-directory.company_gate.1.json"), `${JSON.stringify(sharedDirectory)}\n`, "utf8");
    await runRoutineDirectoryPurge({ company: "company_gate", group: "group_gate", subjectKey: "subject_a", dir: tempDirectory }, () => undefined);
    const names = await readdir(tempDirectory);
    expect(names).toContain("routine-directory.company_gate.tombstones.json");
    expect(names).toContain("routine-directory.company_gate.2.json");
    expect(JSON.parse(await readFile(join(tempDirectory, "routine-directory.company_gate.tombstones.json"), "utf8"))).toEqual({ ids: ["shared_routine"] });
    const surviving = loadRoutineDirectoryProviderFromDirectory(tempDirectory).directories.get("company_gate");
    expect(surviving?.sections[0]?.entries.map(({ id }) => id)).toEqual(["survivor"]);

    const recomputed = await harness.reporting.buildReport({ companyId: "company_gate", groupId: "group_gate", directory: surviving });
    expect(harness.state.activities).toHaveLength(1);
    expect(recomputed.internal.routines).toEqual([expect.objectContaining({ key: { roleId: "role_sales", routineKey: "общая сверка" } })]);
    expect(recomputed.internal.routines).not.toContainEqual(expect.objectContaining({ key: { roleId: "role_sales", routineId: "shared_routine" } }));
  });

  it("keeps purge planning scoped to the shared entry and does not cross groups", () => {
    const plan = planDirectoryPurge({
      files: [{ path: "directory.json", directory: {
        ...gateDirectory(),
        sections: [{ roleId: "role_sales", entries: [{ ...gateDirectory().sections[0]!.entries[0]!, id: "shared", provenance: [{ groupId: "group_gate", subjectKey: "subject_a" }, { groupId: "other_group", subjectKey: "subject_b" }] }] }],
      } }],
      scope: { groupId: "group_gate", subjectKey: "subject_a" },
    });
    expect(plan.affectedEntryIds).toEqual(["shared"]);
  });
});
