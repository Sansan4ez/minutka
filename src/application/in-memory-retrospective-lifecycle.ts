import type { WorkRetrospectiveEpisode, WorkRetrospectivePolicy } from "../domain/work-retrospective.js";
import type { TurnMetadata } from "./retrospective-event-store.js";
import type { RecommendationArtifact } from "./retrospective-recommendations.js";
import { recommendationDependsOn, type RetrospectiveLifecycle } from "./retrospective-lifecycle.js";

/** Offline lifecycle fixture shares canonical messages and disposable projection with their adapters. */
export function createInMemoryRetrospectiveLifecycle(state: {
  artifacts: RecommendationArtifact[];
  episodes: WorkRetrospectiveEpisode[];
  policies: WorkRetrospectivePolicy[];
  messages: Array<{ subjectKey: string; metadata?: TurnMetadata | null }>;
}): RetrospectiveLifecycle {
  const matches = (scope: Parameters<RetrospectiveLifecycle["preview"]>[0], record: { companyId: string; groupId: string; subjectKey?: string }) => record.companyId === scope.companyId && (!scope.groupId || record.groupId === scope.groupId) && (!scope.subjectKey || record.subjectKey === scope.subjectKey);
  const subjects = (scope: Parameters<RetrospectiveLifecycle["preview"]>[0]) => new Set(state.episodes.filter(e => matches(scope, e)).map(e => e.subjectKey));
  return {
    async preview(scope) {
      const keys = subjects(scope); if (scope.subjectKey) keys.add(scope.subjectKey);
      return { recommendationVersions: state.artifacts.filter(a => recommendationDependsOn(a, scope)).length,
        retrospectiveEpisodes: state.episodes.filter(e => matches(scope, e)).length,
        retrospectivePolicies: scope.subjectKey ? 0 : state.policies.filter(p => matches(scope, p)).length,
        retrospectiveEvents: state.messages.filter(m => keys.has(m.subjectKey)).reduce((n, m) => n + (m.metadata?.retrospectiveEvents?.length ?? 0) + (m.metadata?.deliveryEvents?.length ?? 0), 0) };
    },
    async purge(scope) {
      const keys = subjects(scope); if (scope.subjectKey) keys.add(scope.subjectKey);
      const remove = <T>(array: T[], predicate: (record: T) => boolean) => { const kept = array.filter(r => !predicate(r)); array.splice(0, array.length, ...kept); };
      remove(state.artifacts, a => recommendationDependsOn(a, scope));
      remove(state.episodes, e => matches(scope, e));
      if (!scope.subjectKey) remove(state.policies, p => matches(scope, p));
      remove(state.messages, m => keys.has(m.subjectKey));
      return { deletedObjectVersions: 0 };
    },
  };
}
