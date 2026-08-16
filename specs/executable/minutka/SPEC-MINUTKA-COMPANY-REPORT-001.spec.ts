import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  COMPANY_REPORT_MIN_PARTICIPANTS,
  COMPANY_REPORT_MIN_ROWS,
  COMPANY_REPORT_OTHER_ROLE_ID,
  CompanyReportingService,
} from "../../../src/application/company-reporting.js";
import { createInMemoryActivityCollectionState } from "../../../src/application/in-memory-activity-collection-store.js";
import { createInMemoryCompanyReportStore } from "../../../src/application/in-memory-company-report-store.js";
import { PersonalAssistantService } from "../../../src/application/personal-assistant-service.js";
import { createInMemoryArtifactContentStore } from "../../../src/application/in-memory-artifact-content-store.js";
import { createInMemoryArtifactStore } from "../../../src/application/in-memory-artifact-store.js";
import type { Participant } from "../../../src/domain/employee.js";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import { listenHttpServer } from "../../../src/server/http/http-server.js";
import { AdminMinutkaClient } from "../../../src/client/sdk/minutka-client.js";
import { HttpAdminMinutkaTransport } from "../../../src/client/sdk/http-transport.js";
import { runMinutkaCli } from "../../../src/client/cli/minutka-cli.js";

const createdAt = "2026-08-15T00:00:00.000Z";

function participant(employeeId: string, companyId: string, groupId: string, roleId: string): Participant {
  return { employeeId, companyId, groupId, roleId, status: "profile_completed", createdAt, updatedAt: createdAt };
}

function reportingRows(companyId: string, groupId: string, roleId: string, count: number) {
  return Array.from({ length: count }, () => ({
    companyId,
    groupId,
    roleId,
    taskCategory: "reporting" as const,
    durationBucket: "30_60m" as const,
    system: "spreadsheets" as const,
    date: "2026-08-15",
  }));
}

function service(participants: Participant[], rows = reportingRows("company_a", "group_a", "role_a", 5)) {
  const activities = createInMemoryActivityCollectionState();
  activities.anonymizedActivities.push(...rows);
  return new CompanyReportingService(createInMemoryCompanyReportStore({ participants, activities }));
}

describe("SPEC-MINUTKA-COMPANY-REPORT-001: company export privacy threshold", () => {
  it("returns an explicit refusal with both failed conditions", async () => {
    const result = await service([
      participant("employee_1", "company_a", "group_a", "role_a"),
      participant("employee_2", "company_a", "group_a", "role_a"),
      participant("employee_3", "company_a", "group_a", "role_a"),
      participant("employee_4", "company_a", "group_a", "role_a"),
    ], reportingRows("company_a", "group_a", "role_a", 4)).exportGroup({ companyId: "company_a", groupId: "group_a" });

    expect(result).toEqual({
      status: "refused",
      companyId: "company_a",
      groupId: "group_a",
      reasons: [
        { code: "insufficient_participants", actual: 4, required: COMPANY_REPORT_MIN_PARTICIPANTS },
        { code: "insufficient_rows", actual: 4, required: COMPANY_REPORT_MIN_ROWS },
      ],
    });
  });

  it("counts only onboarded participants for both the group and role privacy gates", async () => {
    const invited: Participant = {
      employeeId: "employee_invited",
      companyId: "company_a",
      groupId: "group_a",
      status: "invite_issued",
      createdAt,
      updatedAt: createdAt,
    };
    const participants = [
      ...Array.from({ length: 4 }, (_, index) => participant(`employee_${index}`, "company_a", "group_a", "role_a")),
      invited,
    ];

    const result = await service(participants).exportGroup({ companyId: "company_a", groupId: "group_a" });

    expect(result).toMatchObject({
      status: "refused",
      reasons: [{ code: "insufficient_participants", actual: 4, required: COMPANY_REPORT_MIN_PARTICIPANTS }],
    });
  });

  it("takes participant counts from reference/private state rather than anonymized row volume", async () => {
    const participants = Array.from({ length: 4 }, (_, index) => participant(`employee_${index}`, "company_a", "group_a", "role_a"));
    const result = await service(participants, reportingRows("company_a", "group_a", "role_a", 12))
      .exportGroup({ companyId: "company_a", groupId: "group_a" });

    expect(result).toMatchObject({
      status: "refused",
      reasons: [{ code: "insufficient_participants", actual: 4, required: COMPANY_REPORT_MIN_PARTICIPANTS }],
    });
  });

  it("merges roles below five participants into other instead of exposing a separate role row", async () => {
    const participants = [
      ...Array.from({ length: 5 }, (_, index) => participant(`accountant_${index}`, "company_a", "group_a", "role_accountant")),
      ...Array.from({ length: 4 }, (_, index) => participant(`logistician_${index}`, "company_a", "group_a", "role_logistician")),
    ];
    const rows = [
      ...reportingRows("company_a", "group_a", "role_accountant", 5),
      ...reportingRows("company_a", "group_a", "role_logistician", 5),
    ];
    const result = await service(participants, rows).exportGroup({ companyId: "company_a", groupId: "group_a" });

    expect(result.status).toBe("exported");
    if (result.status !== "exported") throw new Error("expected export");
    expect(result.roleSlices.map((slice) => slice.roleId)).toEqual(["role_accountant", COMPANY_REPORT_OTHER_ROLE_ID]);
    expect(result.roleSlices).not.toContainEqual(expect.objectContaining({ roleId: "role_logistician" }));
    expect(result.roleSlices[1]).toMatchObject({ status: "refused", roleId: COMPANY_REPORT_OTHER_ROLE_ID, reasons: [{ code: "insufficient_participants", actual: 4 }] });
  });

  it("enforces the row threshold independently for an otherwise eligible role slice", async () => {
    const participants = [
      ...Array.from({ length: 5 }, (_, index) => participant(`role_a_${index}`, "company_a", "group_a", "role_a")),
      ...Array.from({ length: 5 }, (_, index) => participant(`role_b_${index}`, "company_a", "group_a", "role_b")),
    ];
    const rows = [
      ...reportingRows("company_a", "group_a", "role_a", 4),
      ...reportingRows("company_a", "group_a", "role_b", 5),
    ];
    const result = await service(participants, rows).exportGroup({ companyId: "company_a", groupId: "group_a" });

    expect(result).toMatchObject({
      status: "exported",
      roleSlices: [
        { status: "refused", roleId: "role_a", reasons: [{ code: "insufficient_rows", actual: 4, required: COMPANY_REPORT_MIN_ROWS }] },
        { status: "exported", roleId: "role_b", rowCount: 5 },
      ],
    });
  });

  it("groups category and obstacle as dimensions of the same row", async () => {
    const participants = Array.from({ length: 5 }, (_, index) => participant(`employee_${index}`, "company_a", "group_a", "role_a"));
    const rows = reportingRows("company_a", "group_a", "role_a", 5).map((row, index) => index < 3
      ? { ...row, obstacle: { kind: "routine_pattern" as const, value: "manual_reporting" as const } }
      : row);
    const result = await service(participants, rows).exportGroup({ companyId: "company_a", groupId: "group_a" });

    expect(result).toMatchObject({
      status: "exported",
      roleSlices: [{
        status: "exported",
        aggregates: expect.arrayContaining([
          expect.objectContaining({
            taskCategory: "reporting",
            obstacle: { kind: "routine_pattern", value: "manual_reporting" },
            rows: 3,
          }),
          expect.objectContaining({ taskCategory: "reporting", rows: 2 }),
        ]),
      }],
    });
  });

  it("never includes another company's anonymized rows", async () => {
    const participants = Array.from({ length: 5 }, (_, index) => participant(`employee_${index}`, "company_a", "group_a", "role_a"));
    const rows = [
      ...reportingRows("company_a", "group_a", "role_a", 5),
      ...reportingRows("company_b", "group_b", "role_secret", 7),
    ];
    const result = await service(participants, rows).exportGroup({ companyId: "company_a", groupId: "group_a" });

    expect(result).toMatchObject({ status: "exported", rowCount: 5 });
    expect(JSON.stringify(result)).not.toContain("company_b");
    expect(JSON.stringify(result)).not.toContain("role_secret");
  });

  it("exposes the company-scoped export through the operator CLI", async () => {
    const participants = Array.from({ length: 5 }, (_, index) => participant(`employee_${index}`, "company_a", "group_a", "role_a"));
    const reporting = service(participants);
    const runtime = createInMemoryRuntime({ agentRunner: async () => "unused" });
    const clock = { now: () => createdAt };
    const artifactStore = createInMemoryArtifactStore({
      contentStore: createInMemoryArtifactContentStore(clock),
      clock,
      limits: { maximumBytes: 1_000_000, timeoutMs: 1_000 },
    });
    const application = new PersonalAssistantService(
      runtime.service,
      { async chat() { throw new Error("not used"); } },
      artifactStore,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      reporting,
    );
    const adminToken = "d".repeat(64);
    const server = await listenHttpServer({ application, port: 0, logger: () => undefined, auth: { adminToken, employeeTokens: new Map() } });
    try {
      const client = new AdminMinutkaClient(new HttpAdminMinutkaTransport({ baseUrl: server.url, token: adminToken }));
      const result = await runMinutkaCli(client, ["admin", "company-report", "--company", "company_a", "--group", "group_a"]);
      expect(result).toMatchObject({ exitCode: 0, stderr: [] });
      expect(JSON.parse(result.stdout[0] ?? "{}")).toMatchObject({ status: "exported", companyId: "company_a", groupId: "group_a", rowCount: 5 });
    } finally {
      await server.close();
    }
  });

  it("keeps both thresholds in one code module and documents them in the runbook", () => {
    const runbook = readFileSync("docs/runbooks/company-report-export.md", "utf8");
    expect(runbook).toContain(`COMPANY_REPORT_MIN_PARTICIPANTS = ${COMPANY_REPORT_MIN_PARTICIPANTS}`);
    expect(runbook).toContain(`COMPANY_REPORT_MIN_ROWS = ${COMPANY_REPORT_MIN_ROWS}`);
  });
});
