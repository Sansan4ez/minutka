import { readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COMPANY_REPORT_CONFIDENCE_POLICY,
  CompanyReportingService,
} from "../../../src/application/company-reporting.js";
import { createInMemoryActivityCollectionState } from "../../../src/application/in-memory-activity-collection-store.js";
import { createInMemoryCompanyReportStore } from "../../../src/application/in-memory-company-report-store.js";
import type { PersonalActivityRecord } from "../../../src/application/activity-collection.js";
import type { Participant } from "../../../src/domain/employee.js";
import { runCompanyReportCommand } from "../../../src/runtime/company-report-command.js";

const createdAt = "2026-08-15T00:00:00.000Z";

function participant(employeeId: string, companyId: string, groupId: string, roleId: string): Participant {
  return { employeeId, companyId, groupId, subjectKey: `subject_${employeeId}`, roleId, status: "profile_completed", createdAt, updatedAt: createdAt };
}

function activity(input: {
  id: string; subjectKey: string; companyId?: string; groupId?: string; roleId?: string; date?: string; workObject?: boolean;
  taskCategory?: PersonalActivityRecord["taskCategory"];
  routinePattern?: PersonalActivityRecord["routinePattern"];
  automationCandidate?: PersonalActivityRecord["automationCandidate"];
  energyStressMarker?: PersonalActivityRecord["energyStressMarker"];
  system?: PersonalActivityRecord["system"];
  routineId?: string;
  routineLabel?: string;
  recurrence?: PersonalActivityRecord["recurrence"];
}): PersonalActivityRecord {
  return {
    activityId: input.id,
    employeeId: `employee_for_${input.subjectKey}`,
    subjectKey: input.subjectKey,
    companyId: input.companyId ?? "company_a",
    groupId: input.groupId ?? "group_a",
    roleId: input.roleId ?? "role_sales",
    ...(input.taskCategory ? { taskCategory: input.taskCategory } : {}),
    ...(input.routinePattern ? { routinePattern: input.routinePattern } : {}),
    ...(input.automationCandidate ? { automationCandidate: input.automationCandidate } : {}),
    ...(input.energyStressMarker ? { energyStressMarker: input.energyStressMarker } : {}),
    ...(input.system ? { system: input.system } : {}),
    ...(input.routineId === undefined ? {} : { routineId: input.routineId }),
    ...(input.routineLabel === undefined
      ? (input.workObject === false ? {} : { routineLabel: "test work" })
      : { routineLabel: input.routineLabel }),
    ...(input.recurrence === undefined ? {} : { recurrence: input.recurrence }),
    durationBucket: "30_60m",
    activityDate: input.date ?? "2026-08-15",
    recordedAt: `${input.date ?? "2026-08-15"}T10:00:00.000Z`,
  };
}

function service(participants: Participant[], personalActivities: PersonalActivityRecord[], reference?: Parameters<typeof createInMemoryCompanyReportStore>[0]["reference"]) {
  const activities = createInMemoryActivityCollectionState();
  activities.activities.push(...personalActivities);
  return new CompanyReportingService(createInMemoryCompanyReportStore({ participants, activities, reference }), () => "2026-08-18T00:00:00.000Z");
}

function automationActivity(id: string, subjectKey: string, date: string, roleId = "role_sales") {
  return activity({ id, subjectKey, date, roleId, taskCategory: "reporting", routinePattern: "manual_reporting", system: "spreadsheets" });
}

describe("SPEC-MINUTKA-COMPANY-REPORT-001: canonical subject-aware reporting", () => {
  it("maps duration buckets into a sorted time budget and keeps category shares normalized", async () => {
    const participants = [participant("one", "company_a", "group_a", "role_sales"), participant("two", "company_a", "group_a", "role_sales")];
    const rows = [
      activity({ id: "short", subjectKey: "subject_one", taskCategory: "reporting" }),
      { ...activity({ id: "long", subjectKey: "subject_two", taskCategory: "meetings" }), durationBucket: "2_4h" as const },
      { ...activity({ id: "unsized", subjectKey: "subject_one", taskCategory: "reporting" }), durationBucket: undefined },
    ];

    const result = await service(participants, rows).exportGroup({ companyId: "company_a", groupId: "group_a" });

    expect(result.internal.schemaVersion).toBe("minutka-internal-report/v2");
    expect(result.internal.timeBudget).toEqual([
      expect.objectContaining({ taskCategory: "meetings", estimatedHours: 3, share: 0.79, observations: 1, unsizedObservations: 0 }),
      expect.objectContaining({ taskCategory: "reporting", estimatedHours: 0.8, share: 0.21, observations: 2, unsizedObservations: 1 }),
    ]);
    expect(result.internal.coverage).toMatchObject({ unsizedObservations: 1, unattributedObservations: { count: 0, estimatedHours: 0, unsized: 0 } });
    expect(result.internal.timeBudget.reduce((sum, entry) => sum + entry.share, 0)).toBe(1);
  });

  it("counts one subject with twenty activities as one contributor", async () => {
    const participants = [participant("one", "company_a", "group_a", "role_sales")];
    const rows = Array.from({ length: 20 }, (_, index) => automationActivity(`activity_${index}`, "subject_one", `2026-08-${String(1 + (index % 4)).padStart(2, "0")}`));

    const result = await service(participants, rows).exportGroup({ companyId: "company_a", groupId: "group_a" });
    const bucket = result.internal.buckets.find((item) => item.scope.kind === "overall_group");

    expect(bucket).toMatchObject({ contributors: 1, observations: 20, activeDates: 4, confidence: "signal" });
    expect(bucket?.evidenceRefs).toHaveLength(20);
    expect(new Set(bucket?.evidenceRefs.map((ref) => ref.subjectKey))).toEqual(new Set(["subject_one"]));
  });

  it("shows a one-contributor routine under its role without exposing energy signals", async () => {
    const participants = [participant("one", "company_a", "group_a", "role_sales")];
    const directory = {
      schemaVersion: "minutka-routine-directory/v1",
      companyId: "company_a",
      version: "1",
      sections: [{
        roleId: "role_sales",
        entries: [{ id: "sales_report", name: "Подготовка отчётов", description: "Reports", examples: [], quickWin: "deep_dive" as const, provenance: [{ groupId: "group_a", subjectKey: "subject_one" }] }],
      }],
    };
    const rows = Array.from({ length: 4 }, (_, index) => activity({
      id: `routine-${index}`,
      subjectKey: "subject_one",
      roleId: "role_sales",
      routineId: "sales_report",
      routineLabel: "Отчёты",
      routinePattern: index === 0 ? "manual_reporting" : undefined,
      energyStressMarker: "fatigue",
      date: `2026-08-0${index + 1}`,
    }));

    const result = await service(participants, rows, {
      companyLabel: "Компания ACME",
      groupLabel: "Пилотная группа",
      period: { start: "2026-08-01", end: "2026-08-31" },
      roleLabels: { role_sales: "Продажи" },
    }).buildReport({ companyId: "company_a", groupId: "group_a", directory });
    const routine = result.internal.routines[0];

    expect(routine).toMatchObject({ contributors: 1, observations: 4, activeDates: 4, confidence: "signal" });
    expect(result.client.topRoutines).toEqual([expect.objectContaining({
      name: "Подготовка отчётов",
      scope: "Продажи",
      confidence: "signal",
      evidenceSummary: expect.objectContaining({ estimatedHours: 3 }),
    })]);
    expect(result.client.frictionRoutines).toEqual([expect.objectContaining({
      name: "Подготовка отчётов",
      scope: "Продажи",
      signals: { manual_reporting: 1 },
    })]);
    expect(result.client.coverage).toMatchObject({
      coveredRoles: ["Продажи"],
      limitations: expect.arrayContaining(["Роль Продажи представлена одним участником; её рутины — самоотчёт одного человека, не оценка"]),
    });
    expect(result.internal.preflightFindings.filter(({ rule }) => rule === "single_contributor_energy")).toEqual([]);
  });

  it("shows energy signals for a routine with multiple contributors", async () => {
    const participants = [
      participant("one", "company_a", "group_a", "role_sales"),
      participant("two", "company_a", "group_a", "role_sales"),
    ];
    const directory = {
      schemaVersion: "minutka-routine-directory/v1",
      companyId: "company_a",
      version: "1",
      sections: [{
        roleId: "role_sales",
        entries: [{ id: "sales_report", name: "Подготовка отчётов", description: "Reports", examples: [], quickWin: "deep_dive" as const, provenance: [{ groupId: "group_a", subjectKey: "subject_one" }] }],
      }],
    };
    const rows = [
      activity({ id: "one-1", subjectKey: "subject_one", routineId: "sales_report", routineLabel: "Отчёты", routinePattern: "manual_reporting", energyStressMarker: "fatigue", date: "2026-08-01" }),
      activity({ id: "one-2", subjectKey: "subject_one", routineId: "sales_report", routineLabel: "Отчёты", date: "2026-08-02" }),
      activity({ id: "two-1", subjectKey: "subject_two", routineId: "sales_report", routineLabel: "Отчёты", energyStressMarker: "frustration", date: "2026-08-03" }),
    ];

    const result = await service(participants, rows, {
      companyLabel: "Компания ACME",
      groupLabel: "Пилотная группа",
      period: { start: "2026-08-01", end: "2026-08-31" },
      roleLabels: { role_sales: "Продажи" },
    }).buildReport({ companyId: "company_a", groupId: "group_a", directory });

    expect(result.client.frictionRoutines).toEqual([expect.objectContaining({
      scope: "Продажи",
      signals: { manual_reporting: 1, fatigue: 1, frustration: 1 },
    })]);
    expect(result.client.coverage.coveredRoles).toEqual(["Продажи"]);
    expect(result.client.coverage.limitations).not.toContain("Роль Продажи представлена одним участником; её рутины — самоотчёт одного человека, не оценка");
  });

  it("omits a single-contributor routine with energy only from friction routines", async () => {
    const participants = [participant("one", "company_a", "group_a", "role_sales")];
    const directory = {
      schemaVersion: "minutka-routine-directory/v1",
      companyId: "company_a",
      version: "1",
      sections: [{
        roleId: "role_sales",
        entries: [{ id: "sales_report", name: "Подготовка отчётов", description: "Reports", examples: [], quickWin: "deep_dive" as const, provenance: [{ groupId: "group_a", subjectKey: "subject_one" }] }],
      }],
    };
    const rows = Array.from({ length: 3 }, (_, index) => activity({
      id: `energy-${index}`,
      subjectKey: "subject_one",
      routineId: "sales_report",
      routineLabel: "Отчёты",
      energyStressMarker: "fatigue",
      date: `2026-08-0${index + 1}`,
    }));

    const result = await service(participants, rows).buildReport({ companyId: "company_a", groupId: "group_a", directory });

    expect(result.client.topRoutines).toHaveLength(1);
    expect(result.client.frictionRoutines).toEqual([]);
  });

  it("promotes confidence with distinct subjects, observations, and dates", async () => {
    const participants = ["one", "two", "three"].map((id) => participant(id, "company_a", "group_a", "role_sales"));
    const rows = [
      automationActivity("a1", "subject_one", "2026-08-01"),
      automationActivity("a2", "subject_one", "2026-08-02"),
      automationActivity("a3", "subject_two", "2026-08-02"),
      automationActivity("a4", "subject_two", "2026-08-03"),
      automationActivity("a5", "subject_three", "2026-08-03"),
    ];

    const result = await service(participants, rows).exportGroup({ companyId: "company_a", groupId: "group_a" });

    expect(result.internal.buckets.find((item) => item.scope.kind === "overall_group")).toMatchObject({
      contributors: COMPANY_REPORT_CONFIDENCE_POLICY.confirmedSubjects,
      observations: COMPANY_REPORT_CONFIDENCE_POLICY.confirmedObservations,
      activeDates: COMPANY_REPORT_CONFIDENCE_POLICY.confirmedDates,
      confidence: "confirmed",
    });
    expect(result.client.topRoutines).toEqual([]);
    expect(result.client.cannotConclude).toContain("Эффект и prerequisites быстрых улучшений требуют обследования процесса (второй этап)");
  });

  it("keeps supporting automation and human-impact facets inside one observed process", async () => {
    const participants = [
      participant("one", "company_a", "group_a", "role_sales"),
      participant("two", "company_a", "group_a", "role_sales"),
    ];
    const rows = [
      activity({ id: "a1", subjectKey: "subject_one", date: "2026-08-01", taskCategory: "reporting", routinePattern: "manual_reporting", automationCandidate: "report_generation", energyStressMarker: "frustration", system: "spreadsheets" }),
      activity({ id: "a2", subjectKey: "subject_two", date: "2026-08-02", taskCategory: "reporting", routinePattern: "manual_reporting", automationCandidate: "template_or_checklist", energyStressMarker: "fatigue", system: "email" }),
      activity({ id: "a3", subjectKey: "subject_one", date: "2026-08-03", taskCategory: "reporting", routinePattern: "manual_reporting", automationCandidate: "report_generation", energyStressMarker: "fatigue" }),
    ];

    const result = await service(participants, rows).exportGroup({ companyId: "company_a", groupId: "group_a" });
    const overall = result.internal.buckets.filter((bucket) => bucket.scope.kind === "overall_group");

    expect(overall).toHaveLength(1);
    expect(overall[0]).toMatchObject({
      bucketId: "overall-reporting-manual_reporting",
      process: { taskCategory: "reporting", routinePattern: "manual_reporting" },
      contributors: 2,
      observations: 3,
      supportingEvidence: {
        automationHypotheses: [
          expect.objectContaining({ value: "report_generation", observations: 2, confidence: "signal" }),
          expect.objectContaining({ value: "template_or_checklist", observations: 1, confidence: "hypothesis" }),
        ],
        humanImpactSignals: [
          expect.objectContaining({ value: "fatigue", observations: 2, confidence: "signal" }),
          expect.objectContaining({ value: "frustration", observations: 1, confidence: "hypothesis" }),
        ],
      },
    });
    expect(result.client.topRoutines).toEqual([]);
    expect(result.client.frictionRoutines).toEqual([]);
  });

  it("does not promote an automation hypothesis or energy marker without observed friction to a recommendation", async () => {
    const participants = [participant("one", "company_a", "group_a", "role_sales")];
    const rows = [
      activity({ id: "a1", subjectKey: "subject_one", taskCategory: "reporting", automationCandidate: "report_generation", energyStressMarker: "fatigue", system: "spreadsheets" }),
    ];

    const result = await service(participants, rows).exportGroup({ companyId: "company_a", groupId: "group_a" });

    expect(result.internal.buckets.filter((bucket) => bucket.scope.kind === "overall_group")).toEqual([
      expect.objectContaining({
        process: { taskCategory: "reporting" },
        supportingEvidence: {
          automationHypotheses: [expect.objectContaining({ value: "report_generation" })],
          humanImpactSignals: [expect.objectContaining({ value: "fatigue" })],
        },
      }),
    ]);
    expect(result.client.topRoutines).toEqual([]);
    expect(result.client.frictionRoutines).toEqual([]);
    expect(result.client.deepDive).toEqual([]);
  });

  it("returns a rare-role process signal without employee evaluation or raw quote", async () => {
    const participants = [
      participant("tender", "company_a", "group_a", "role_tender_specialist"),
      participant("sales", "company_a", "group_a", "role_sales"),
    ];
    const rows = [
      activity({ id: "t1", subjectKey: "subject_tender", roleId: "role_tender_specialist", taskCategory: "admin", automationCandidate: "data_entry_reduction", system: "email" }),
      activity({ id: "s1", subjectKey: "subject_sales", roleId: "role_sales", taskCategory: "meetings" }),
    ];

    const result = await service(participants, rows).exportGroup({ companyId: "company_a", groupId: "group_a" });
    const serializedClient = JSON.stringify(result.client);

    expect(result.client.topRoutines).toEqual([]);
    expect(result.client.coverage.coveredRoles).toEqual([]);
    expect(serializedClient).not.toMatch(/subject_|employee_|raw|quote|trace|message/i);
  });

  it("keeps activities without a work object out of the budget and counts them as unattributed", async () => {
    const participants = [participant("one", "company_a", "group_a", "role_sales")];
    const rows = [
      activity({ id: "named", subjectKey: "subject_one", taskCategory: "reporting" }),
      activity({ id: "unattributed", subjectKey: "subject_one", taskCategory: "reporting", workObject: false }),
      { ...activity({ id: "unattributed_unsized", subjectKey: "subject_one", taskCategory: "meetings", workObject: false }), durationBucket: undefined },
    ];

    const result = await service(participants, rows).exportGroup({ companyId: "company_a", groupId: "group_a" });

    expect(result.internal.timeBudget).toEqual([expect.objectContaining({ taskCategory: "reporting", observations: 1, estimatedHours: 0.8 })]);
    expect(result.internal.buckets.every((bucket) => bucket.observations === 1)).toBe(true);
    expect(result.internal.coverage.unattributedObservations).toEqual({ count: 2, estimatedHours: 0.8, unsized: 1 });
  });

  it("builds deterministic role-scoped routines from a validated directory and free labels", async () => {
    const participants = [
      participant("sales", "company_a", "group_a", "role_sales"),
      participant("logistics", "company_a", "group_a", "role_logistics"),
    ];
    const directory = {
      schemaVersion: "minutka-routine-directory/v1",
      companyId: "company_a",
      version: "1",
      sections: [
        { roleId: "role_sales", entries: [{ id: "sales_report", name: "Подготовка отчётов", description: "Reports", examples: ["Prepare reports"], quickWin: "report_template", provenance: [{ groupId: "group_a", subjectKey: "subject_sales" }] }] },
        { roleId: "role_logistics", entries: [{ id: "logistics_report", name: "Подготовка отчётов", description: "Reports", examples: ["Prepare reports"], quickWin: "deep_dive", provenance: [{ groupId: "group_a", subjectKey: "subject_logistics" }] }] },
      ],
    };
    const rows = [
      activity({ id: "sales-id", subjectKey: "subject_sales", roleId: "role_sales", routineId: "sales_report", routineLabel: "Отчёт", recurrence: "weekly", taskCategory: "reporting", routinePattern: "manual_reporting", energyStressMarker: "fatigue" }),
      activity({ id: "sales-id-2", subjectKey: "subject_sales", roleId: "role_sales", routineId: "sales_report", routineLabel: "Отчёт", date: "2026-08-16" }),
      activity({ id: "sales-id-3", subjectKey: "subject_sales", roleId: "role_sales", routineId: "sales_report", routineLabel: "Отчёт", date: "2026-08-17" }),
      activity({ id: "sales-free", subjectKey: "subject_sales", roleId: "role_sales", routineLabel: "Подготовка, писем", taskCategory: "communication" }),
      activity({ id: "logistics-id", subjectKey: "subject_logistics", roleId: "role_logistics", routineId: "logistics_report", routineLabel: "Отчёт", taskCategory: "reporting" }),
      activity({ id: "logistics-id-2", subjectKey: "subject_logistics", roleId: "role_logistics", routineId: "logistics_report", routineLabel: "Отчёт", date: "2026-08-16" }),
      activity({ id: "logistics-id-3", subjectKey: "subject_logistics", roleId: "role_logistics", routineId: "logistics_report", routineLabel: "Отчёт", date: "2026-08-17" }),
      activity({ id: "dangling", subjectKey: "subject_sales", roleId: "role_sales", routineId: "removed", routineLabel: "Свободная работа", taskCategory: "admin" }),
      activity({ id: "unattributed", subjectKey: "subject_sales", roleId: "role_sales", routineId: "removed", workObject: false, taskCategory: "admin" }),
    ];
    const reporting = service(participants, rows, {
      companyLabel: "Компания ACME",
      groupLabel: "Пилотная группа",
      period: { start: "2026-08-01", end: "2026-08-31" },
      roleLabels: { role_sales: "Продажи", role_logistics: "Логистика" },
    });

    const first = await reporting.buildReport({ companyId: "company_a", groupId: "group_a", directory });
    const second = await reporting.buildReport({ companyId: "company_a", groupId: "group_a", directory });
    expect(first).toEqual(second);
    expect(first.internal.directoryVersion).toBe("1");
    expect(first.internal.routines).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: { roleId: "role_sales", routineId: "sales_report" }, name: "Подготовка отчётов", quickWin: "report_template", statedRecurrence: { weekly: 1 }, frictionSignals: { count: 1, byValue: { manual_reporting: 1 } }, energySignals: { count: 1, byValue: { fatigue: 1 } } }),
      expect.objectContaining({ key: { roleId: "role_logistics", routineId: "logistics_report" }, name: "Подготовка отчётов", quickWin: "deep_dive" }),
      expect.objectContaining({ key: { roleId: "role_sales", routineKey: "свободная работа" } }),
      expect.objectContaining({ key: { roleId: "role_sales", routineKey: "подготовка писем" } }),
    ]));
    expect(first.internal.routines).toHaveLength(4);
    expect(first.client).toMatchObject({
      schemaVersion: "minutka-client-report.v2",
      title: "Карта рутин и быстрых улучшений",
      companyLabel: "Компания ACME",
      groupLabel: "Пилотная группа",
      period: { start: "2026-08-01", end: "2026-08-31" },
      coverage: {
        coveredRoles: ["Логистика", "Продажи"],
        limitations: expect.arrayContaining([
          "Роль Логистика представлена одним участником; её рутины — самоотчёт одного человека, не оценка",
          "Роль Продажи представлена одним участником; её рутины — самоотчёт одного человека, не оценка",
        ]),
      },
    });
    expect(first.client.topRoutines).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Подготовка отчётов", scope: "Продажи", quickWin: expect.objectContaining({ id: "report_template" }) }),
    ]));
    expect(first.client.frictionRoutines).toEqual([
      expect.objectContaining({ name: "Подготовка отчётов", scope: "Продажи", signals: { manual_reporting: 1 } }),
    ]);
    expect(first.client.deepDive).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Подготовка отчётов", scope: "Логистика" }),
    ]));
    expect(first.client.firstSteps).toHaveLength(1);
    expect(JSON.stringify(first.client)).not.toMatch(/subjectKey|routineKey|variants|evidenceRefs|routineLabel|mostFrequentLabel|roleId/);
    expect(first.internal.coverage.unattributedObservations).toMatchObject({ count: 1 });
    expect(first.internal.timeBudget).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskCategory: "admin", observations: 1 }),
    ]));
    expect(JSON.stringify(first.internal.routines)).not.toContain("provenance");
  });

  it("keeps named routines with fewer than three observations internal-only", async () => {
    const participants = [participant("one", "company_a", "group_a", "role_sales")];
    const directory = {
      schemaVersion: "minutka-routine-directory/v1",
      companyId: "company_a",
      version: "2",
      sections: [{
        roleId: "role_sales",
        entries: [{ id: "rare", name: "Редкая рутина", description: "Rare", examples: [], quickWin: "deep_dive" as const, provenance: [{ groupId: "group_a", subjectKey: "subject_one" }] }],
      }],
    };
    const rows = [
      activity({ id: "rare-1", subjectKey: "subject_one", routineId: "rare", routineLabel: "Редкая рутина", date: "2026-08-15" }),
      activity({ id: "rare-2", subjectKey: "subject_one", routineId: "rare", routineLabel: "Редкая рутина", date: "2026-08-16" }),
    ];
    const result = await service(participants, rows).buildReport({ companyId: "company_a", groupId: "group_a", directory });
    expect(result.internal.routines).toEqual([expect.objectContaining({ name: "Редкая рутина", observations: 2 })]);
    expect(result.client.topRoutines).toEqual([]);
    expect(result.client.frictionRoutines).toEqual([]);
    expect(result.client.firstSteps).toEqual([]);
    expect(result.client.deepDive).toEqual([]);
    expect(result.client.cannotConclude).toContain("Рутины с менее чем тремя наблюдениями за цикл не показаны");

    const enough = await service(participants, [
      ...rows,
      activity({ id: "rare-3", subjectKey: "subject_one", routineId: "rare", routineLabel: "Редкая рутина", date: "2026-08-17" }),
    ]).buildReport({ companyId: "company_a", groupId: "group_a", directory });
    expect(enough.client.topRoutines).toEqual([expect.objectContaining({ name: "Редкая рутина" })]);
    expect(enough.client.deepDive).toEqual([expect.objectContaining({ name: "Редкая рутина" })]);
  });

  it("rejects a directory belonging to another company before building the report", async () => {
    const reporting = service([participant("one", "company_a", "group_a", "role_sales")], []);
    await expect(reporting.buildReport({ companyId: "company_a", groupId: "group_a", directory: {
      schemaVersion: "minutka-routine-directory/v1", companyId: "company_b", version: "1", sections: [],
    } })).rejects.toMatchObject({ code: "directory_scope_mismatch" });
  });

  it("builds a report in process from a large directory file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "minutka-directory-"));
    const file = join(directory, "directory.json");
    const output = join(directory, "report.json");
    const payload = {
      schemaVersion: "minutka-routine-directory/v1", companyId: "company_a", version: "1",
      sections: [{ roleId: "role_sales", entries: [{ id: "sales_report", name: "Подготовка отчётов", description: "x".repeat(100_000), examples: [], quickWin: "deep_dive", provenance: [{ groupId: "group_a", subjectKey: "subject_one" }] }] }],
    };
    writeFileSync(file, JSON.stringify(payload));
    const participants = [participant("one", "company_a", "group_a", "role_sales")];
    const reporting = service(participants, [activity({ id: "a1", subjectKey: "subject_one", routineId: "sales_report", routineLabel: "Отчёты" })]);
    const writes: string[] = [];
    await runCompanyReportCommand(["build", "--company", "company_a", "--group", "group_a", "--directory", file, "--out", output], {
      reporting,
      checkLlm: async () => ({ object: { results: [] } }),
    }, (text) => writes.push(text));
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual(await reporting.buildReport({ companyId: "company_a", groupId: "group_a", directory: payload }));
    expect(writes).toHaveLength(1);
  });

  it("keeps subject-linked refs internal and excludes identities and source refs from the client DTO", async () => {
    const participants = [participant("secret", "company_a", "group_a", "role_sales")];
    const result = await service(participants, [automationActivity("activity_secret", "subject_secret", "2026-08-15")])
      .exportGroup({ companyId: "company_a", groupId: "group_a" });

    expect(result.internal.buckets[0]?.evidenceRefs).toEqual([{ kind: "activity", id: "activity_secret", subjectKey: "subject_secret" }]);
    const client = JSON.stringify(result.client);
    expect(client).not.toContain("subject_secret");
    expect(client).not.toContain("activity_secret");
    expect(client).not.toContain("employeeId");
    expect(client).not.toContain("evidenceRefs");
  });

  it("never includes another company and fails closed on a cross-scope store result", async () => {
    const participants = [participant("one", "company_a", "group_a", "role_sales")];
    const rows = [automationActivity("a1", "subject_one", "2026-08-15"), automationActivity("b1", "subject_b", "2026-08-15", "role_secret")];
    rows[1] = { ...rows[1]!, companyId: "company_b", groupId: "group_b" };
    const clean = await service(participants, rows).exportGroup({ companyId: "company_a", groupId: "group_a" });
    expect(JSON.stringify(clean)).not.toContain("company_b");
    expect(JSON.stringify(clean)).not.toContain("role_secret");

    const unsafeStore = { async loadGroupSnapshot() { return { invitedParticipants: 1, subjects: [{ subjectKey: "subject_one" }], activities: [rows[1]!] }; } };
    await expect(new CompanyReportingService(unsafeStore).exportGroup({ companyId: "company_a", groupId: "group_a" }))
      .rejects.toThrow("cross-scope canonical activity");
  });

  it("recomputes from current canonical activities after correction and purge", async () => {
    const participants = [participant("one", "company_a", "group_a", "role_sales")];
    const state = createInMemoryActivityCollectionState();
    state.activities.push(automationActivity("a1", "subject_one", "2026-08-15"));
    const reporting = new CompanyReportingService(createInMemoryCompanyReportStore({ participants, activities: state }));

    expect((await reporting.exportGroup({ companyId: "company_a", groupId: "group_a" })).client.topRoutines).toEqual([]);
    state.activities[0] = activity({ id: "a1", subjectKey: "subject_one", taskCategory: "reporting", automationCandidate: "report_generation", system: "spreadsheets" });
    const corrected = await reporting.exportGroup({ companyId: "company_a", groupId: "group_a" });
    expect(corrected.client.topRoutines).toEqual([]);
    expect(corrected.internal.buckets.find((bucket) => bucket.scope.kind === "overall_group")).toMatchObject({
      process: { taskCategory: "reporting" },
      supportingEvidence: { automationHypotheses: [expect.objectContaining({ value: "report_generation" })] },
    });
    state.activities.length = 0;
    expect((await reporting.exportGroup({ companyId: "company_a", groupId: "group_a" })).client).toMatchObject({ coverage: { assessment: "insufficient", observations: 0 }, topRoutines: [], frictionRoutines: [], firstSteps: [], deepDive: [] });
  });

  it("returns a directory-free report through the HTTP export path", async () => {
    const participants = [participant("one", "company_a", "group_a", "role_sales")];
    const result = await service(participants, [automationActivity("a1", "subject_one", "2026-08-15")]).exportGroup({ companyId: "company_a", groupId: "group_a" });
    expect(result.client.topRoutines).toEqual([]);
    expect(result.client.frictionRoutines).toEqual([]);
    expect(result.client.firstSteps).toEqual([]);
    expect(result.client.deepDive).toEqual([]);
  });

  it("documents canonical recompute, confidence thresholds, and the client delivery boundary", () => {
    const runbook = readFileSync("docs/runbooks/company-report-export.md", "utf8");
    expect(runbook).toContain("minutka_private.activities");
    expect(runbook).not.toContain("minutka_reporting.anonymized_activities");
    expect(runbook).toContain("confirmedSubjects = 3");
    expect(runbook).toContain("subject keys");
  });
});
