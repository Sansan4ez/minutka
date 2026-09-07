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
import { PersonalAssistantService } from "../../../src/application/personal-assistant-service.js";
import { createInMemoryArtifactContentStore } from "../../../src/application/in-memory-artifact-content-store.js";
import { createInMemoryArtifactStore } from "../../../src/application/in-memory-artifact-store.js";
import type { PersonalActivityRecord } from "../../../src/application/activity-collection.js";
import type { Participant } from "../../../src/domain/employee.js";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import { listenHttpServer } from "../../../src/server/http/http-server.js";
import { AdminMinutkaClient } from "../../../src/client/sdk/minutka-client.js";
import { HttpAdminMinutkaTransport } from "../../../src/client/sdk/http-transport.js";
import { runMinutkaCli } from "../../../src/client/cli/minutka-cli.js";

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

function service(participants: Participant[], personalActivities: PersonalActivityRecord[]) {
  const activities = createInMemoryActivityCollectionState();
  activities.activities.push(...personalActivities);
  return new CompanyReportingService(createInMemoryCompanyReportStore({ participants, activities }), () => "2026-08-18T00:00:00.000Z");
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
    expect(result.client.recommendations).toEqual([expect.objectContaining({
      confidence: "confirmed",
      problem: "Отчётность готовится вручную",
      evidenceSummary: expect.objectContaining({ contributors: 3, observations: 5, activeDates: 3 }),
    })]);
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
    expect(result.client.recommendations).toEqual([expect.objectContaining({
      process: "Подготовка отчётности",
      problem: "Отчётность готовится вручную",
      priority: "elevated",
      automationOption: expect.stringContaining("Automation hypotheses для проверки методологом"),
      humanImpact: expect.arrayContaining([expect.stringContaining("усталость"), expect.stringContaining("фрустрация")]),
    })]);
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
    expect(result.client.recommendations).toEqual([]);
    expect(result.client.insufficientEvidence).toEqual([expect.objectContaining({
      question: expect.stringContaining("automation hypothesis"),
      allowedConclusion: expect.stringContaining("наблюдаемая проблема ещё не подтверждена"),
    })]);
  });

  it("returns a rare-role process hypothesis without employee evaluation or raw quote", async () => {
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

    expect(result.client.insufficientEvidence).toEqual([expect.objectContaining({ scope: "Редкая рабочая функция", allowedConclusion: expect.stringContaining("не оценка сотрудника") })]);
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
      version: "directory-1",
      sections: [
        { roleId: "role_sales", entries: [{ id: "sales_report", name: "Подготовка отчётов", description: "Reports", examples: ["Prepare reports"], quickWin: "report_template", provenance: [{ groupId: "group_a", subjectKey: "subject_sales" }] }] },
        { roleId: "role_logistics", entries: [{ id: "logistics_report", name: "Подготовка отчётов", description: "Reports", examples: ["Prepare reports"], quickWin: "deep_dive", provenance: [{ groupId: "group_a", subjectKey: "subject_logistics" }] }] },
      ],
    };
    const rows = [
      activity({ id: "sales-id", subjectKey: "subject_sales", roleId: "role_sales", routineId: "sales_report", routineLabel: "Отчёт", recurrence: "weekly", taskCategory: "reporting", routinePattern: "manual_reporting", energyStressMarker: "fatigue" }),
      activity({ id: "sales-free", subjectKey: "subject_sales", roleId: "role_sales", routineLabel: "Подготовка, писем", taskCategory: "communication" }),
      activity({ id: "logistics-id", subjectKey: "subject_logistics", roleId: "role_logistics", routineId: "logistics_report", routineLabel: "Отчёт", taskCategory: "reporting" }),
      activity({ id: "dangling", subjectKey: "subject_sales", roleId: "role_sales", routineId: "removed", routineLabel: "Свободная работа", taskCategory: "admin" }),
      activity({ id: "unattributed", subjectKey: "subject_sales", roleId: "role_sales", routineId: "removed", workObject: false, taskCategory: "admin" }),
    ];
    const reporting = service(participants, rows);

    const first = await reporting.buildReport({ companyId: "company_a", groupId: "group_a", directory });
    const second = await reporting.buildReport({ companyId: "company_a", groupId: "group_a", directory });
    expect(first).toEqual(second);
    expect(first.internal.directoryVersion).toBe("directory-1");
    expect(first.internal.routines).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: { roleId: "role_sales", routineId: "sales_report" }, name: "Подготовка отчётов", quickWin: "report_template", statedRecurrence: { weekly: 1 }, frictionSignals: { count: 1, byValue: { manual_reporting: 1 } }, energySignals: { count: 1, byValue: { fatigue: 1 } } }),
      expect.objectContaining({ key: { roleId: "role_logistics", routineId: "logistics_report" }, name: "Подготовка отчётов", quickWin: "deep_dive" }),
      expect.objectContaining({ key: { roleId: "role_sales", routineKey: "свободная работа" } }),
      expect.objectContaining({ key: { roleId: "role_sales", routineKey: "подготовка писем" } }),
    ]));
    expect(first.internal.routines).toHaveLength(4);
    expect(first.internal.coverage.unattributedObservations).toMatchObject({ count: 1 });
    expect(first.internal.timeBudget).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskCategory: "admin", observations: 1 }),
    ]));
    expect(JSON.stringify(first.internal.routines)).not.toContain("provenance");
  });

  it("rejects a directory belonging to another company before building the report", async () => {
    const reporting = service([participant("one", "company_a", "group_a", "role_sales")], []);
    await expect(reporting.buildReport({ companyId: "company_a", groupId: "group_a", directory: {
      schemaVersion: "minutka-routine-directory/v1", companyId: "company_b", version: "directory-1", sections: [],
    } })).rejects.toMatchObject({ code: "directory_scope_mismatch" });
  });

  it("passes --directory from the operator CLI", async () => {
    const directory = mkdtempSync(join(tmpdir(), "minutka-directory-"));
    const file = join(directory, "directory.json");
    writeFileSync(file, JSON.stringify({
      schemaVersion: "minutka-routine-directory/v1", companyId: "company_a", version: "directory-1", sections: [],
    }));
    const participants = [participant("one", "company_a", "group_a", "role_sales")];
    const reporting = service(participants, [activity({ id: "a1", subjectKey: "subject_one", routineLabel: "Free work" })]);
    const runtime = createInMemoryRuntime({ agentRunner: async () => "unused" });
    const clock = { now: () => createdAt };
    const artifactStore = createInMemoryArtifactStore({ contentStore: createInMemoryArtifactContentStore(clock), clock, limits: { maximumBytes: 1_000_000, timeoutMs: 1_000 } });
    const application = new PersonalAssistantService(runtime.service, { async chat() { throw new Error("not used"); } }, artifactStore, undefined, undefined, undefined, undefined, undefined, undefined, reporting);
    const adminToken = "d".repeat(64);
    const server = await listenHttpServer({ application, port: 0, logger: () => undefined, auth: { adminToken, employeeTokens: new Map() } });
    try {
      const client = new AdminMinutkaClient(new HttpAdminMinutkaTransport({ baseUrl: server.url, token: adminToken }));
      const result = await runMinutkaCli(client, ["admin", "company-report", "--company", "company_a", "--group", "group_a", "--directory", file]);
      expect(result).toMatchObject({ exitCode: 0, stderr: [] });
      expect(JSON.parse(result.stdout[0] ?? "{}")).toMatchObject({ internal: { directoryVersion: "directory-1" } });
    } finally { await server.close(); }
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

    expect((await reporting.exportGroup({ companyId: "company_a", groupId: "group_a" })).client.recommendations[0]).toMatchObject({
      process: "Подготовка отчётности",
      problem: "Отчётность готовится вручную",
    });
    state.activities[0] = activity({ id: "a1", subjectKey: "subject_one", taskCategory: "reporting", automationCandidate: "report_generation", system: "spreadsheets" });
    const corrected = await reporting.exportGroup({ companyId: "company_a", groupId: "group_a" });
    expect(corrected.client.recommendations).toEqual([]);
    expect(corrected.internal.buckets.find((bucket) => bucket.scope.kind === "overall_group")).toMatchObject({
      process: { taskCategory: "reporting" },
      supportingEvidence: { automationHypotheses: [expect.objectContaining({ value: "report_generation" })] },
    });
    state.activities.length = 0;
    expect((await reporting.exportGroup({ companyId: "company_a", groupId: "group_a" })).client).toMatchObject({ coverage: { assessment: "insufficient", observations: 0 }, recommendations: [] });
  });

  it("exposes the separate internal/client DTO through the operator CLI", async () => {
    const participants = [participant("one", "company_a", "group_a", "role_sales")];
    const reporting = service(participants, [automationActivity("a1", "subject_one", "2026-08-15")]);
    const runtime = createInMemoryRuntime({ agentRunner: async () => "unused" });
    const clock = { now: () => createdAt };
    const artifactStore = createInMemoryArtifactStore({ contentStore: createInMemoryArtifactContentStore(clock), clock, limits: { maximumBytes: 1_000_000, timeoutMs: 1_000 } });
    const application = new PersonalAssistantService(runtime.service, { async chat() { throw new Error("not used"); } }, artifactStore, undefined, undefined, undefined, undefined, undefined, undefined, reporting);
    const adminToken = "d".repeat(64);
    const server = await listenHttpServer({ application, port: 0, logger: () => undefined, auth: { adminToken, employeeTokens: new Map() } });
    try {
      const client = new AdminMinutkaClient(new HttpAdminMinutkaTransport({ baseUrl: server.url, token: adminToken }));
      const result = await runMinutkaCli(client, ["admin", "company-report", "--company", "company_a", "--group", "group_a"]);
      const dto = JSON.parse(result.stdout[0] ?? "{}");
      expect(result).toMatchObject({ exitCode: 0, stderr: [] });
      expect(dto).toMatchObject({ internal: { companyId: "company_a", groupId: "group_a" }, client: { schemaVersion: "minutka-client-report.v1" } });
      expect(JSON.stringify(dto.client)).not.toContain("subject_one");
    } finally { await server.close(); }
  });

  it("documents canonical recompute, confidence thresholds, and the client delivery boundary", () => {
    const runbook = readFileSync("docs/runbooks/company-report-export.md", "utf8");
    expect(runbook).toContain("minutka_private.activities");
    expect(runbook).not.toContain("minutka_reporting.anonymized_activities");
    expect(runbook).toContain("confirmedSubjects = 3");
    expect(runbook).toContain("subject keys");
  });
});
