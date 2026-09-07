import { describe, expect, it } from "vitest";
import { ClientReportFindingError, ClientReportPublishingService } from "../../../src/application/client-report-publishing.js";
import { hashClientReport, type ReportPreflightFindingsFile } from "../../../src/application/report-preflight.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createDeterministicIdGenerator } from "../../../src/application/runtime-primitives.js";

describe("SPEC-MINUTKA-CLIENT-REPORT-PUBLISH-001: high preflight findings require methodological decisions", () => {
  type Finding = { id: string; field: "routine.name" | "routine.variants" | "policy"; rule: string; excerpt: string; severity: "high" | "medium" | "low" };
  function harness(findings: Finding[] = [{ id: "high-1", field: "routine.name", rule: "pii", excerpt: "redacted", severity: "high" }]) {
    const world = createInMemoryWorld(() => "2026-09-07T12:00:00.000Z");
    const audit = createInMemoryAuditEventStore(world);
    const client = { schemaVersion: "minutka-client-report.v2" };
    const reporting = { async buildReport() { return { internal: { preflightFindings: findings }, client } as never; } };
    const file = (supplied: Finding[] = []): ReportPreflightFindingsFile => ({ schemaVersion: "minutka-report-preflight-findings/v1", scope: "company_a/group_a", reportVersion: hashClientReport(client as never), findings: supplied });
    return { world, service: new ClientReportPublishingService(reporting, audit, { now: world.now }, createDeterministicIdGenerator()), file };
  }

  it("requires a findings file and refuses unresolved high findings with only safe refusal metadata", async () => {
    const { world, service, file } = harness();
    const missing = await service.publishClientReport({ companyId: "company_a", groupId: "group_a", findings: undefined as never });
    expect(missing).toEqual({ ok: false, reason: "missing_findings" });
    const result = await service.publishClientReport({ companyId: "company_a", groupId: "group_a", findings: file() });
    expect(result).toEqual({ ok: false, reason: "unresolved_high_findings", findingIds: ["high-1"] });
    expect(world.auditEvents.at(-1)).toMatchObject({ type: "client_report_publish_refused", metadata: { scope: "company_a/group_a", reason: "unresolved_high_findings", findingIds: ["high-1"] } });
    expect(JSON.stringify(world.auditEvents)).not.toContain("redacted");
  });

  it("accepts verified and fixed decisions only for the exact group scope", async () => {
    const { world, service, file } = harness();
    await service.resolvePreflightFinding({ companyId: "company_a", groupId: "other_group", findingId: "high-1", decision: "verified" });
    expect((await service.publishClientReport({ companyId: "company_a", groupId: "group_a", findings: file() })).ok).toBe(false);
    await service.resolvePreflightFinding({ companyId: "company_a", groupId: "group_a", findingId: "high-1", decision: "fixed" });
    const result = await service.publishClientReport({ companyId: "company_a", groupId: "group_a", findings: file() });
    expect(result).toMatchObject({ ok: true, reportVersion: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(world.auditEvents.at(-1)?.type).toBe("client_report_published");
  });

  it("does not block medium findings and ties decisions to the current report version", async () => {
    const medium = harness([{ id: "medium-1", field: "routine.variants", rule: "quote", excerpt: "x", severity: "medium" }]);
    expect((await medium.service.publishClientReport({ companyId: "company_a", groupId: "group_a", findings: medium.file() })).ok).toBe(true);
    const changed = harness([{ id: "high-2", field: "routine.name", rule: "pii", excerpt: "changed", severity: "high" }]);
    await changed.service.resolvePreflightFinding({ companyId: "company_a", groupId: "group_a", findingId: "high-2", decision: "verified" });
    expect((await changed.service.publishClientReport({ companyId: "company_a", groupId: "group_a", findings: changed.file() })).ok).toBe(true);
  });

  it("rejects findings for a different report version and unknown resolution ids", async () => {
    const { service, file } = harness();
    expect(await service.publishClientReport({ companyId: "company_a", groupId: "group_a", findings: { ...file(), reportVersion: "f".repeat(64) } })).toEqual({ ok: false, reason: "stale_findings" });
    await expect(service.resolvePreflightFinding({ companyId: "company_a", groupId: "group_a", findingId: "unknown", decision: "verified" })).rejects.toMatchObject({ code: "unknown_finding" });
    await expect(service.resolvePreflightFinding({ companyId: "company_a", groupId: "group_a", findingId: "unknown", decision: "verified" })).rejects.toBeInstanceOf(ClientReportFindingError);
  });

  it("allows a high LLM finding from the current findings file after its decision", async () => {
    const llm = harness([]);
    const finding = { id: "llm-1", field: "routine.name" as const, rule: "llm_identifying_detail", excerpt: "rare role", severity: "high" as const, reason: "rare" };
    const llmFile = llm.file([finding]);
    expect(await llm.service.publishClientReport({ companyId: "company_a", groupId: "group_a", findings: llmFile })).toEqual({ ok: false, reason: "unresolved_high_findings", findingIds: ["llm-1"] });
    await llm.service.resolvePreflightFinding({ companyId: "company_a", groupId: "group_a", findingId: "llm-1", decision: "verified", findings: llmFile });
    expect((await llm.service.publishClientReport({ companyId: "company_a", groupId: "group_a", findings: llmFile })).ok).toBe(true);
    expect(llm.world.auditEvents.at(-1)?.metadata).toMatchObject({ llmFindings: "applied" });
  });
});
