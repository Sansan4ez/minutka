import { safeAuditMetadata } from "./audit-event-store.js";
import type { InMemoryActivityCollectionState } from "./in-memory-activity-collection-store.js";
import type { InMemoryEvaluationCaseState } from "./in-memory-evaluation-case-store.js";
import { emptyDeletionCounts, inviteIndexFor } from "./in-memory-profile-store.js";
import type { InMemoryResearchTraceState } from "./in-memory-research-trace-store.js";
import type { InMemoryWorld } from "./in-memory-world.js";
import {
  researchScopePurgeAuditMetadata,
  type ResearchScope,
  type ResearchScopePurgeCounts,
  type ResearchScopePurgeStore,
} from "./research-scope-purge.js";

export type InMemoryResearchScopePurgeFixture = {
  world: InMemoryWorld;
  activities?: InMemoryActivityCollectionState;
  traces?: InMemoryResearchTraceState;
  evaluationCases?: InMemoryEvaluationCaseState;
};

const purgeMarkerCounters = new WeakMap<InMemoryWorld, number>();

/** Executable-spec adapter over the same fixture the research stores write. */
export function createInMemoryResearchScopePurgeStore(
  fixture: InMemoryResearchScopePurgeFixture,
): ResearchScopePurgeStore {
  const { world } = fixture;
  const inScope = (scope: ResearchScope) => (record: { companyId: string; groupId: string }) =>
    record.companyId === scope.companyId && (!scope.groupId || record.groupId === scope.groupId);
  const scopeEmployeeIds = (scope: ResearchScope) =>
    new Set(world.participants.filter(inScope(scope)).map((participant) => participant.employeeId));
  const counts = (scope: ResearchScope): ResearchScopePurgeCounts => {
    const employeeIds = scopeEmployeeIds(scope);
    const owned = (records: Array<{ employeeId: string }>) =>
      records.filter((record) => employeeIds.has(record.employeeId)).length;
    return {
      ...emptyDeletionCounts(),
      participants: employeeIds.size,
      profiles: owned(world.profiles),
      consents: owned(world.consents),
      messages: owned(world.messages),
      insights: owned(world.insights),
      feedback: owned(world.feedback),
      onboardingDrafts: owned(world.onboardingDrafts),
      auditEvents: world.auditEvents.filter((record) => record.employeeId && employeeIds.has(record.employeeId)).length,
      activities: (fixture.activities?.activities ?? []).filter(inScope(scope)).length,
      traces: (fixture.traces?.traces ?? []).filter(inScope(scope)).length,
      evaluationCases: (fixture.evaluationCases?.cases ?? []).filter(inScope(scope)).length,
    };
  };

  return {
    async countScope(scope) {
      return counts(scope);
    },
    async listScopeEmployeeIds(scope) {
      return [...scopeEmployeeIds(scope)].sort();
    },
    async purgeScope({ deletedObjectVersions, ...scope }) {
      const deleted = counts(scope);
      const employeeIds = scopeEmployeeIds(scope);
      const owned = (record: { employeeId: string }) => employeeIds.has(record.employeeId);
      removeInPlace(world.participants, owned);
      removeInPlace(world.profiles, owned);
      removeInPlace(world.consents, owned);
      removeInPlace(world.messages, owned);
      removeInPlace(world.insights, owned);
      removeInPlace(world.feedback, owned);
      removeInPlace(world.onboardingDrafts, owned);
      removeInPlace(world.auditEvents, (record) => Boolean(record.employeeId && employeeIds.has(record.employeeId)));
      removeInPlace(world.events, (record) => "employeeId" in record && employeeIds.has(record.employeeId as string));
      if (fixture.activities) removeInPlace(fixture.activities.activities, inScope(scope));
      if (fixture.traces) removeInPlace(fixture.traces.traces, inScope(scope));
      if (fixture.evaluationCases) removeInPlace(fixture.evaluationCases.cases, inScope(scope));
      const invites = inviteIndexFor(world);
      for (const [inviteCode, employeeId] of invites) {
        if (employeeIds.has(employeeId)) invites.delete(inviteCode);
      }
      appendPurgeMarker(world, scope, deleted, deletedObjectVersions);
      return deleted;
    },
  };
}

function removeInPlace<T>(records: T[], shouldRemove: (record: T) => boolean): void {
  const kept = records.filter((record) => !shouldRemove(record));
  records.splice(0, records.length, ...kept);
}

function appendPurgeMarker(
  world: InMemoryWorld,
  scope: ResearchScope,
  deleted: ResearchScopePurgeCounts,
  objectVersions: number,
): void {
  const counter = (purgeMarkerCounters.get(world) ?? 0) + 1;
  purgeMarkerCounters.set(world, counter);
  world.auditEvents.push({
    id: `research-scope-purge-${counter}`,
    requestId: `research-scope-purge-${counter}`,
    type: "research_scope_purged",
    occurredAt: world.now(),
    metadata: safeAuditMetadata("research_scope_purged", researchScopePurgeAuditMetadata(scope, deleted, objectVersions)),
  });
}
