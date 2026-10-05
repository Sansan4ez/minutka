import type { ResearchScope } from "./research-scope-purge.js";
import type { RecommendationArtifact } from "./retrospective-recommendations.js";

export type RetrospectiveDeletionCounts = { recommendationVersions: number; retrospectiveEpisodes: number; retrospectiveEvents: number; retrospectivePolicies: number };
/** Operator-only lifecycle port. Physical deletion includes inactive artifacts and every object version. */
export type RetrospectiveLifecycle = {
  preview(scope: ResearchScope & { subjectKey?: string }): Promise<RetrospectiveDeletionCounts>;
  purge(scope: ResearchScope & { subjectKey?: string }): Promise<{ deletedObjectVersions: number }>;
};
export function recommendationDependsOn(artifact: RecommendationArtifact, scope: ResearchScope & { subjectKey?: string }): boolean {
  return artifact.scope.companyId === scope.companyId && (!scope.groupId || artifact.scope.groupId === scope.groupId)
    && (!scope.subjectKey || artifact.contributors.includes(scope.subjectKey));
}
