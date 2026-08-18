import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CollectActivityService } from "../../../src/application/activity-collection.js";
import {
  createInMemoryActivityCollectionState,
  createInMemoryActivityCollectionStore,
} from "../../../src/application/in-memory-activity-collection-store.js";
import {
  createInMemoryEvaluationCaseState,
  createInMemoryEvaluationCaseStore,
} from "../../../src/application/in-memory-evaluation-case-store.js";
import {
  createInMemoryResearchTraceState,
  createInMemoryResearchTraceStore,
} from "../../../src/application/in-memory-research-trace-store.js";
import { PersistenceError } from "../../../src/application/persistence-error.js";
import { evaluationCaseSchemaVersion } from "../../../src/application/research-evaluation.js";
import { researchTraceSchemaVersion } from "../../../src/application/research-trace-store.js";
import { createTenantSubjectScopeIndex } from "../../../src/application/tenant-subject-scope.js";

const now = "2026-08-19T09:00:00.000Z";
const migrationPath = "migrations/0062_bind_tenant_subject_tuples.sql";

const scopeA = { companyId: "company-a", groupId: "group-a", subjectKey: "subject-a" };

function trace(overrides: Partial<{ companyId: string; groupId: string; subjectKey: string; traceId: string }> = {}) {
  return {
    schemaVersion: researchTraceSchemaVersion,
    traceId: "trace-a",
    requestId: "request-a",
    messageId: "message-a",
    ...scopeA,
    ...overrides,
    processIds: ["core"],
    promptVersion: "prompt/v1",
    processVersion: "process/v1",
    taxonomyVersion: "taxonomy/v1",
    model: "openai/test",
    samplingRate: 1 as const,
    input: { text: "утренний чек-ин", modality: "text" as const },
    attempts: [{ attempt: 1, context: "bounded", modelSteps: [], toolCalls: [], toolResults: [] }],
    output: "ok",
    startedAt: now,
    completedAt: now,
    latencyMs: 0,
    status: "completed" as const,
  };
}

function evaluationCase(overrides: Partial<{ caseId: string; companyId: string; groupId: string; subjectKey: string }> = {}) {
  return {
    schemaVersion: evaluationCaseSchemaVersion,
    caseId: "case-a",
    ...scopeA,
    ...overrides,
    traceId: "trace-a",
    requestId: "request-a",
    messageId: "message-a",
    promptVersion: "prompt/v1",
    processVersion: "process/v1",
    taxonomyVersion: "taxonomy/v1",
    model: "openai/test",
    labels: { usefulness: "useful", accuracy: "accurate", clarification: "not_needed", extractionCorrectness: "correct" },
    createdAt: now,
  } as const;
}

describe("SPEC-MINUTKA-TENANT-SUBJECT-TUPLE-001: tenant/subject tuples stay whole", () => {
  it("rejects canonical and research records that mix one subject with another company/group", async () => {
    const tenantScope = createTenantSubjectScopeIndex();
    const activityState = createInMemoryActivityCollectionState();
    const traceState = createInMemoryResearchTraceState();
    const evaluationState = createInMemoryEvaluationCaseState();
    const activities = new CollectActivityService(
      createInMemoryActivityCollectionStore(activityState, { tenantScope }),
      { now: () => now },
      () => "activity-a",
    );
    const traces = createInMemoryResearchTraceStore(traceState, { tenantScope });
    const evaluations = createInMemoryEvaluationCaseStore(evaluationState, { tenantScope });

    await activities.collect({
      employeeId: "employee-a",
      ...scopeA,
      roleId: "role-a",
      timezone: "Etc/UTC",
      activity: { taskCategory: "reporting" },
    });
    await traces.append(trace());
    await evaluations.create(evaluationCase());

    // The subject belongs to one company and group only.
    await expect(traces.append(trace({ traceId: "trace-b", groupId: "group-b" })))
      .rejects.toThrow(new PersistenceError("persistence_conflict"));
    await expect(activities.collect({
      employeeId: "employee-a",
      ...scopeA,
      companyId: "company-b",
      roleId: "role-a",
      timezone: "Etc/UTC",
      activity: { taskCategory: "reporting" },
    })).rejects.toThrow(new PersistenceError("persistence_conflict"));
    // An employee's canonical records carry that employee's own subject.
    await expect(activities.collect({
      employeeId: "employee-a",
      ...scopeA,
      subjectKey: "subject-b",
      roleId: "role-a",
      timezone: "Etc/UTC",
      activity: { taskCategory: "reporting" },
    })).rejects.toThrow(new PersistenceError("persistence_conflict"));
    // An evaluation case belongs to the tuple of its trace, not only to its id.
    await expect(evaluations.create(evaluationCase({ caseId: "case-b", subjectKey: "subject-b" })))
      .rejects.toThrow(new PersistenceError("persistence_conflict"));

    expect(activityState.activities).toHaveLength(1);
    expect(traceState.traces).toHaveLength(1);
    expect(evaluationState.cases).toHaveLength(1);
  });

  it("accepts a second subject of the same group and keeps every store scoped", async () => {
    const tenantScope = createTenantSubjectScopeIndex();
    const traceState = createInMemoryResearchTraceState();
    const traces = createInMemoryResearchTraceStore(traceState, { tenantScope });

    await traces.append(trace());
    await traces.append(trace({ traceId: "trace-b", subjectKey: "subject-b" }));

    expect(traceState.traces.map((record) => record.traceId)).toEqual(["trace-a", "trace-b"]);
  });

  it("pins the tuple with composite keys in the canonical schema", () => {
    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toContain("participants_employee_subject_unique UNIQUE (employee_id, subject_key)");
    expect(sql).toContain("participants_tenant_subject_unique UNIQUE (company_id, group_id, subject_key)");
    for (const constraint of [
      "messages_owner_subject_fk",
      "activities_owner_subject_fk",
      "activities_tenant_subject_fk",
      "traces_tenant_subject_fk",
      "evaluation_cases_trace_tenant_subject_fk",
    ]) {
      expect(sql).toContain(`ADD CONSTRAINT ${constraint}`);
    }
    expect(sql).toMatch(/traces_tenant_subject_unique UNIQUE \(trace_id, company_id, group_id, subject_key\)/u);
    expect(sql).toMatch(/evaluation_cases_trace_tenant_subject_fk\s+FOREIGN KEY \(trace_id, company_id, group_id, subject_key\)/u);
    // Every dropped single-column key is subsumed by the composite key above it.
    expect(sql.match(/DROP CONSTRAINT (\w+)/gu)).toEqual([
      "DROP CONSTRAINT messages_subject_fk",
      "DROP CONSTRAINT activities_employee_id_fkey",
      "DROP CONSTRAINT activities_subject_fk",
      "DROP CONSTRAINT traces_subject_key_fkey",
      "DROP CONSTRAINT evaluation_cases_trace_id_fkey",
      "DROP CONSTRAINT evaluation_cases_subject_key_fkey",
    ]);
  });
});
