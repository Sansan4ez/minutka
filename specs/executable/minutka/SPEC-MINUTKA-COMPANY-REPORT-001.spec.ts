import { readFileSync } from "node:fs";
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
  id: string; subjectKey: string; companyId?: string; groupId?: string; roleId?: string; date?: string;
  taskCategory?: PersonalActivityRecord["taskCategory"];
  obstacle?: PersonalActivityRecord["obstacle"];
  system?: PersonalActivityRecord["system"];
}): PersonalActivityRecord {
  return {
    activityId: input.id,
    employeeId: `employee_for_${input.subjectKey}`,
    subjectKey: input.subjectKey,
    companyId: input.companyId ?? "company_a",
    groupId: input.groupId ?? "group_a",
    roleId: input.roleId ?? "role_sales",
    ...(input.taskCategory ? { taskCategory: input.taskCategory } : {}),
    ...(input.obstacle ? { obstacle: input.obstacle } : {}),
    ...(input.system ? { system: input.system } : {}),
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
  return activity({ id, subjectKey, date, roleId, taskCategory: "reporting", obstacle: { kind: "routine_pattern", value: "manual_reporting" }, system: "spreadsheets" });
}

describe("SPEC-MINUTKA-COMPANY-REPORT-001: canonical subject-aware reporting", () => {
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
    expect(result.client.recommendations).toEqual([expect.objectContaining({ confidence: "confirmed", evidenceSummary: expect.objectContaining({ contributors: 3, observations: 5, activeDates: 3 }) })]);
  });

  it("returns a rare-role process hypothesis without employee evaluation or raw quote", async () => {
    const participants = [
      participant("tender", "company_a", "group_a", "role_tender_specialist"),
      participant("sales", "company_a", "group_a", "role_sales"),
    ];
    const rows = [
      activity({ id: "t1", subjectKey: "subject_tender", roleId: "role_tender_specialist", taskCategory: "admin", obstacle: { kind: "automation_candidate", value: "data_entry_reduction" }, system: "email" }),
      activity({ id: "s1", subjectKey: "subject_sales", roleId: "role_sales", taskCategory: "meetings" }),
    ];

    const result = await service(participants, rows).exportGroup({ companyId: "company_a", groupId: "group_a" });
    const serializedClient = JSON.stringify(result.client);

    expect(result.client.insufficientEvidence).toEqual([expect.objectContaining({ scope: "Редкая рабочая функция", allowedConclusion: expect.stringContaining("не оценка сотрудника") })]);
    expect(serializedClient).not.toMatch(/subject_|employee_|raw|quote|trace|message/i);
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

    expect((await reporting.exportGroup({ companyId: "company_a", groupId: "group_a" })).client.recommendations[0]?.process).toContain("ручная отчётность");
    state.activities[0] = activity({ id: "a1", subjectKey: "subject_one", taskCategory: "reporting", obstacle: { kind: "automation_candidate", value: "report_generation" }, system: "spreadsheets" });
    expect((await reporting.exportGroup({ companyId: "company_a", groupId: "group_a" })).client.recommendations[0]?.process).toContain("генерация отчётов");
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
