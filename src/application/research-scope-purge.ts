import { z } from "zod";
import type { SafeAuditMetadata } from "./audit-event-store.js";
import type { EmployeeObjectDeletionStore } from "./employee-data-deletion.js";
import type { EmployeePersonalDataDeletionCounts } from "./profile-store.js";

const purgeScopeSchema = z.strictObject({
  companyId: z.string().trim().min(1),
  groupId: z.string().trim().min(1).optional(),
});

export type ResearchScopePurgeInput = z.input<typeof purgeScopeSchema>;
/** Exact company, or exact company/group. Any wider scope is not a typed operation. */
export type ResearchScope = { companyId: string; groupId?: string };

export type ResearchScopePurgeCounts = EmployeePersonalDataDeletionCounts & {
  traces: number;
  evaluationCases: number;
};

export type ResearchScopePurgeStore = {
  countScope(scope: ResearchScope): Promise<ResearchScopePurgeCounts>;
  listScopeEmployeeIds(scope: ResearchScope): Promise<string[]>;
  /**
   * Deletes the scope and records one identity-free audit row in the same
   * transaction. `deletedObjectVersions` is the object-store count of the same
   * operation, so a single audit record describes the whole purge.
   */
  purgeScope(input: ResearchScope & { deletedObjectVersions: number }): Promise<ResearchScopePurgeCounts>;
};

export type ResearchScopeDescriptor = { kind: "company" | "group"; companyId: string; groupId?: string };

export type ResearchScopePurgePreview = {
  scope: ResearchScopeDescriptor;
  counts: ResearchScopePurgeCounts;
  /** The exact line the operator must type before the irreversible purge runs. */
  confirmation: string;
};

export type ResearchScopePurgeResult = {
  scope: ResearchScopeDescriptor;
  deleted: ResearchScopePurgeCounts & { minioObjectVersions: number };
  preserved: {
    anonymousPurgeAudit: true;
    tenantReferenceDirectories: "kept";
    deliveredClientArtifacts: "not_recalled";
  };
  oldInvitesRevoked: true;
};

export function describeResearchScope(scope: ResearchScope): ResearchScopeDescriptor {
  return scope.groupId
    ? { kind: "group", companyId: scope.companyId, groupId: scope.groupId }
    : { kind: "company", companyId: scope.companyId };
}

export function researchScopePurgeConfirmation(scope: ResearchScope): string {
  return scope.groupId
    ? `PURGE GROUP ${scope.companyId}/${scope.groupId}`
    : `PURGE COMPANY ${scope.companyId}`;
}

/** Scope, counts and outcome; the allow-list drops anything a caller adds beyond them. */
export function researchScopePurgeAuditMetadata(
  scope: ResearchScope,
  deleted: ResearchScopePurgeCounts,
  objectVersions: number,
): SafeAuditMetadata {
  return {
    scope: scope.groupId ? "group" : "company",
    companyId: scope.companyId,
    ...(scope.groupId ? { groupId: scope.groupId } : {}),
    outcome: "purged",
    participants: deleted.participants,
    messages: deleted.messages,
    activities: deleted.activities,
    traces: deleted.traces,
    feedback: deleted.feedback,
    evaluationCases: deleted.evaluationCases,
    insights: deleted.insights,
    auditEvents: deleted.auditEvents,
    objectVersions,
  };
}

/**
 * Irreversible operator-only use-case for the company and company/group scopes
 * promised by `privacy-v6`. It is intentionally not exposed as an agent tool.
 * Object versions are removed before the database scope so a storage failure
 * leaves the participants available for a safe retry of the same command.
 */
export class ResearchScopePurgeService {
  constructor(
    private readonly store: ResearchScopePurgeStore,
    private readonly objects: EmployeeObjectDeletionStore,
  ) {}

  async preview(input: ResearchScopePurgeInput): Promise<ResearchScopePurgePreview> {
    const scope = parseScope(input);
    const counts = await this.store.countScope(scope);
    if (!counts.participants) throw new Error("research_scope_not_found");
    return { scope: describeResearchScope(scope), counts, confirmation: researchScopePurgeConfirmation(scope) };
  }

  async purge(input: ResearchScopePurgeInput): Promise<ResearchScopePurgeResult> {
    const scope = parseScope(input);
    const employeeIds = await this.store.listScopeEmployeeIds(scope);
    if (!employeeIds.length) throw new Error("research_scope_not_found");

    let minioObjectVersions = 0;
    for (const employeeId of employeeIds) {
      minioObjectVersions += (await this.objects.deleteByEmployee(employeeId)).deletedObjectVersions;
    }
    const deleted = await this.store.purgeScope({ ...scope, deletedObjectVersions: minioObjectVersions });
    return {
      scope: describeResearchScope(scope),
      deleted: { ...deleted, minioObjectVersions },
      preserved: {
        anonymousPurgeAudit: true,
        tenantReferenceDirectories: "kept",
        deliveredClientArtifacts: "not_recalled",
      },
      oldInvitesRevoked: true,
    };
  }
}

function parseScope(input: ResearchScopePurgeInput): ResearchScope {
  const parsed = purgeScopeSchema.parse(input);
  return { companyId: parsed.companyId, ...(parsed.groupId ? { groupId: parsed.groupId } : {}) };
}
