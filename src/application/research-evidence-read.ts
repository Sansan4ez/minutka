import type { AuditEventStore } from "./audit-event-store.js";
import type { EvaluationCaseStore, EvaluationHumanLabels } from "./research-evaluation.js";
import {
  sanitizeResearchTrace,
  type ResearchTraceRecord,
  type ResearchTraceStatus,
  type ResearchTraceStore,
} from "./research-trace-store.js";
import { randomIdGenerator, systemClock, type Clock } from "./runtime-primitives.js";

export type ResearchEvidenceScope = { companyId: string; groupId: string };

export type EvaluationCaseListItem = {
  caseId: string;
  subjectKey: string;
  traceId: string;
  labels: EvaluationHumanLabels;
  createdAt: string;
};

export type ResearchTraceListInput = ResearchEvidenceScope & {
  subjectKey?: string;
  traceId?: string;
  from?: string;
  to?: string;
};

export type ResearchTraceListItem = {
  traceId: string;
  subjectKey: string;
  status: ResearchTraceStatus;
  promptVersion: string;
  processVersion: string;
  taxonomyVersion: string;
  model: string;
  startedAt: string;
  completedAt: string;
};

type ReadOperation = "evaluation_list" | "traces_list" | "traces_get";

export class ResearchEvidenceReadService {
  constructor(
    private readonly evaluations: Pick<EvaluationCaseStore, "list">,
    private readonly traces: Pick<ResearchTraceStore, "list" | "get">,
    private readonly audit?: AuditEventStore,
    private readonly clock: Clock = systemClock,
    private readonly auditId: () => string = randomIdGenerator.auditEventId,
  ) {}

  async listEvaluationCases(input: ResearchEvidenceScope): Promise<EvaluationCaseListItem[]> {
    const scope = normalizeScope(input);
    return this.withAudit("evaluation_list", scope, async () => {
      const records = await this.evaluations.list(scope);
      assertExactScope(scope, records);
      return records.map(({ caseId, subjectKey, traceId, labels, createdAt }) => ({
        caseId,
        subjectKey,
        traceId,
        labels: { ...labels },
        createdAt,
      }));
    }, (records) => records.length);
  }

  async listTraces(input: ResearchTraceListInput): Promise<ResearchTraceListItem[]> {
    const scope = normalizeScope(input);
    const subjectKey = normalizeOptional(input.subjectKey);
    const traceId = normalizeOptional(input.traceId);
    const from = normalizeDate(input.from, "from", false);
    const to = normalizeDate(input.to, "to", true);
    if (from && to && Date.parse(from) > Date.parse(to)) throw new Error("from must not be later than to");
    return this.withAudit("traces_list", scope, async () => {
      const records = await this.traces.list({
        ...scope,
        ...(subjectKey ? { subjectKey } : {}),
        ...(traceId ? { traceId } : {}),
        ...(from ? { startedFrom: from } : {}),
        ...(to ? { startedTo: to } : {}),
      });
      assertExactScope(scope, records);
      return records.map(traceMetadata);
    }, (records) => records.length);
  }

  async getTrace(input: ResearchEvidenceScope & { traceId: string }): Promise<ResearchTraceRecord | undefined> {
    const scope = normalizeScope(input);
    const traceId = normalizeRequired(input.traceId, "traceId");
    return this.withAudit("traces_get", scope, async () => {
      const trace = await this.traces.get({ ...scope, traceId });
      if (!trace) return undefined;
      assertExactScope(scope, [trace]);
      return sanitizeResearchTrace(trace);
    }, (trace) => trace ? 1 : 0);
  }

  private async withAudit<T>(
    operation: ReadOperation,
    scope: ResearchEvidenceScope,
    read: () => Promise<T>,
    count: (result: T) => number,
  ): Promise<T> {
    const occurredAt = this.clock.now();
    try {
      const result = await read();
      await this.auditRead(operation, scope, "succeeded", count(result), occurredAt);
      return result;
    } catch (error) {
      await this.auditRead(operation, scope, "failed", 0, occurredAt);
      throw error;
    }
  }

  private async auditRead(
    operation: ReadOperation,
    scope: ResearchEvidenceScope,
    outcome: "succeeded" | "failed",
    count: number,
    occurredAt: string,
  ): Promise<void> {
    if (!this.audit) return;
    await this.audit.append({
      id: this.auditId(),
      requestId: `research_read:${operation}:${scope.companyId}:${scope.groupId}:${occurredAt}`,
      type: "research_evidence_read",
      occurredAt,
      metadata: { companyId: scope.companyId, groupId: scope.groupId, operation, outcome, count },
    });
  }
}

function traceMetadata(trace: ResearchTraceRecord): ResearchTraceListItem {
  return {
    traceId: trace.traceId,
    subjectKey: trace.subjectKey,
    status: trace.status,
    promptVersion: trace.promptVersion,
    processVersion: trace.processVersion,
    taxonomyVersion: trace.taxonomyVersion,
    model: trace.model,
    startedAt: trace.startedAt,
    completedAt: trace.completedAt,
  };
}

function normalizeScope(input: ResearchEvidenceScope): ResearchEvidenceScope {
  return {
    companyId: normalizeRequired(input.companyId, "companyId"),
    groupId: normalizeRequired(input.groupId, "groupId"),
  };
}

function normalizeRequired(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function normalizeDate(value: string | undefined, field: string, endOfDay: boolean): string | undefined {
  const normalized = normalizeOptional(value);
  if (!normalized) return undefined;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(normalized);
  const timestamp = Date.parse(dateOnly ? `${normalized}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z` : normalized);
  if (Number.isNaN(timestamp)) throw new Error(`${field} must be an ISO-8601 date or datetime`);
  return new Date(timestamp).toISOString();
}

function assertExactScope(
  scope: ResearchEvidenceScope,
  records: Array<{ companyId: string; groupId: string }>,
): void {
  if (records.some((record) => record.companyId !== scope.companyId || record.groupId !== scope.groupId)) {
    throw new Error("research evidence store returned a cross-scope record");
  }
}
