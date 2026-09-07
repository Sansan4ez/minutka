import { describe, expect, it } from "vitest";
import { ClientReportPublishingService } from "../../../src/application/client-report-publishing.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createDeterministicIdGenerator } from "../../../src/application/runtime-primitives.js";

describe("SPEC-MINUTKA-CLIENT-REPORT-PUBLISH-001: high preflight findings require methodological decisions", () => {
  function harness(findings: Array<{ id: string; field: "routine.name" | "routine.variants" | "policy"; rule: string; excerpt: string; severity: "high" | "medium" | "low" }> = [{ id: "high-1", field: "routine.name", rule: "pii", excerpt: "redacted", severity: "high" }]) {
    const world = createInMemoryWorld(() => "2026-09-07T12:00:00.000Z");
    const audit = createInMemoryAuditEventStore(world);
    const reporting = { async buildReport() { return { internal: { preflightFindings: findings }, client: { schemaVersion: "minutka-client-report.v2" } } as never; } };
    return { world, service: new ClientReportPublishingService(reporting, audit, { now: world.now }, createDeterministicIdGenerator()) };
  }

  it("refuses unresolved high findings and records only safe refusal metadata", async () => {
    const { world, service } = harness();
    const result = await service.publishClientReport({ companyId: "company_a", groupId: "group_a" });
    expect(result).toEqual({ ok: false, reason: "unresolved_high_findings", findingIds: ["high-1"] });
    expect(world.auditEvents).toMatchObject([{ type: "client_report_publish_refused", metadata: { scope: "company_a/group_a", reason: "unresolved_high_findings", findingIds: ["high-1"] } }]);
    expect(JSON.stringify(world.auditEvents)).not.toContain("redacted");
  });

  it("accepts verified and fixed decisions only for the exact group scope", async () => {
    const { world, service } = harness();
    await service.resolvePreflightFinding({ companyId: "company_a", groupId: "other_group", findingId: "high-1", decision: "verified" });
    expect((await service.publishClientReport({ companyId: "company_a", groupId: "group_a" })).ok).toBe(false);
    await service.resolvePreflightFinding({ companyId: "company_a", groupId: "group_a", findingId: "high-1", decision: "fixed" });
    const result = await service.publishClientReport({ companyId: "company_a", groupId: "group_a" });
    expect(result).toMatchObject({ ok: true, reportVersion: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(world.auditEvents.at(-1)?.type).toBe("client_report_published");
  });

  it("does not block medium findings and ties decisions to the current report version", async () => {
    const medium = harness([{ id: "medium-1", field: "routine.variants", rule: "quote", excerpt: "x", severity: "medium" }]);
    expect((await medium.service.publishClientReport({ companyId: "company_a", groupId: "group_a" })).ok).toBe(true);
    const changed = harness([{ id: "high-2", field: "routine.name", rule: "pii", excerpt: "changed", severity: "high" }]);
    await changed.service.resolvePreflightFinding({ companyId: "company_a", groupId: "group_a", findingId: "high-2", decision: "verified" });
    expect((await changed.service.publishClientReport({ companyId: "company_a", groupId: "group_a" })).ok).toBe(true);
  });
});
