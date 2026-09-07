import { createHash } from "node:crypto";
import type { AuditEventStore } from "./audit-event-store.js";
import type { ClientCompanyReport, CompanyReportingService } from "./company-reporting.js";
import type { PreflightFinding } from "./report-preflight.js";
import { randomIdGenerator, systemClock, type Clock, type IdGenerator } from "./runtime-primitives.js";

export type PreflightFindingDecision = "verified" | "fixed";
export type ClientReportPublishRefused = {
  ok: false;
  reason: "unresolved_high_findings";
  findingIds: string[];
};
export type ClientReportPublished = {
  ok: true;
  client: ClientCompanyReport;
  reportVersion: string;
};
export type ClientReportPublishResult = ClientReportPublishRefused | ClientReportPublished;

export class ClientReportPublishingService {
  constructor(
    private readonly reporting: Pick<CompanyReportingService, "buildReport">,
    private readonly audit: AuditEventStore,
    private readonly clock: Clock = systemClock,
    private readonly idGenerator: IdGenerator = randomIdGenerator,
    private readonly reviewer = "methodologist",
  ) {}

  async resolvePreflightFinding(input: {
    companyId: string;
    groupId: string;
    findingId: string;
    decision: PreflightFindingDecision;
    directory?: unknown;
    note?: string;
  }): Promise<{ ok: true }> {
    const scope = normalizeScope(input);
    const findingId = required(input.findingId, "findingId");
    const report = await this.reporting.buildReport({ companyId: scope.companyId, groupId: scope.groupId, directory: input.directory });
    const occurredAt = this.clock.now();
    await this.audit.append({
      id: this.idGenerator.auditEventId(),
      requestId: `report_preflight_decision:${scope.scope}:${findingId}:${occurredAt}`,
      type: "report_preflight_decision",
      occurredAt,
      metadata: {
        scope: scope.scope,
        findingId,
        decision: input.decision,
        reportVersion: hashClientReport(report.client),
        reviewer: this.reviewer,
      },
    });
    return { ok: true };
  }

  async publishClientReport(input: {
    companyId: string;
    groupId: string;
    directory?: unknown;
    findings?: PreflightFinding[];
  }): Promise<ClientReportPublishResult> {
    const scope = normalizeScope(input);
    const report = await this.reporting.buildReport({
      companyId: scope.companyId,
      groupId: scope.groupId,
      directory: input.directory,
    });
    const findings = mergeFindings(report.internal.preflightFindings, input.findings ?? []);
    const highFindings = findings.filter((finding) => finding.severity === "high");
    const reportVersion = hashClientReport(report.client);
    const occurredAt = this.clock.now();
    const decisions = await this.listDecisions(scope.scope);
    const resolved = new Set(
      decisions
        .filter((event) => event.metadata.decision === "verified" || event.metadata.decision === "fixed")
        .filter((event) => event.metadata.reportVersion === reportVersion)
        .map((event) => String(event.metadata.findingId ?? "")),
    );
    const unresolved = highFindings.filter((finding) => !resolved.has(finding.id)).map((finding) => finding.id);
    if (unresolved.length > 0) {
      await this.audit.append({
        id: this.idGenerator.auditEventId(),
        requestId: `client_report_publish_refused:${scope.scope}:${occurredAt}`,
        type: "client_report_publish_refused",
        occurredAt,
        metadata: {
          scope: scope.scope,
          reportVersion,
          reason: "unresolved_high_findings",
          findingIds: unresolved,
        },
      });
      return { ok: false, reason: "unresolved_high_findings", findingIds: unresolved };
    }
    await this.audit.append({
      id: this.idGenerator.auditEventId(),
      requestId: `client_report_published:${scope.scope}:${occurredAt}`,
      type: "client_report_published",
      occurredAt,
      metadata: { scope: scope.scope, reportVersion, reviewer: this.reviewer },
    });
    return { ok: true, client: report.client, reportVersion };
  }

  private async listDecisions(scope: string) {
    if (!this.audit.listByTypeAndScope) throw new Error("audit store cannot read report preflight decisions");
    return this.audit.listByTypeAndScope({ type: "report_preflight_decision", scope, limit: 10_000 });
  }
}

function normalizeScope(input: { companyId: string; groupId: string }): { companyId: string; groupId: string; scope: string } {
  const companyId = required(input.companyId, "companyId");
  const groupId = required(input.groupId, "groupId");
  return { companyId, groupId, scope: `${companyId}/${groupId}` };
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function mergeFindings(base: PreflightFinding[], supplied: PreflightFinding[]): PreflightFinding[] {
  return [...new Map([...base, ...supplied].map((finding) => [finding.id, finding])).values()];
}

function hashClientReport(client: ClientCompanyReport): string {
  return createHash("sha256").update(JSON.stringify(client), "utf8").digest("hex");
}
