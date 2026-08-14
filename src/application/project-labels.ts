import { NO_PROJECT } from "../domain/classification.js";
import type { IdeaStore } from "./idea-store.js";
import type { TaskReader } from "./task-store.js";

export const assistantProjectListDefaultLimit = 20;
export const assistantProjectListMaximumLimit = 50;
export const assistantProjectSourceScanLimit = 500;

export type AssistantProjectView = {
  project: string;
  ideaCount: number;
  taskCount: number;
  totalCount: number;
};

export type AssistantProjectListResult = {
  projects: AssistantProjectView[];
  truncated: boolean;
};

type CollectedProjectLabels = {
  grouped: Map<string, AssistantProjectView>;
  sourceTruncated: boolean;
};

/** Request-scoped cache; never retain it between AssistantService.chat calls. */
export type ProjectLabelCollectCache = {
  ownerId?: string;
  collected?: Promise<CollectedProjectLabels>;
};

/**
 * Owner-scoped view over project strings already attached to ideas and tasks.
 * A project is deliberately not a separate entity in the pilot data model.
 */
export class ProjectLabelService {
  constructor(
    private readonly ideas?: Pick<IdeaStore, "list">,
    private readonly tasks?: Pick<TaskReader, "list">,
  ) {}

  async list(ownerId: string, input: { limit?: number } = {}, cache?: ProjectLabelCollectCache): Promise<AssistantProjectListResult> {
    const limit = input.limit ?? assistantProjectListDefaultLimit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > assistantProjectListMaximumLimit) {
      throw new Error(`project list limit must be between 1 and ${assistantProjectListMaximumLimit}`);
    }
    const collected = await this.collect(ownerId, cache);
    const projects = [...collected.grouped.values()]
      .sort((left, right) => right.totalCount - left.totalCount || left.project.localeCompare(right.project, "ru"))
      .slice(0, limit);
    return { projects, truncated: collected.sourceTruncated || collected.grouped.size > limit };
  }

  async canonicalize(ownerId: string, project: string, cache?: ProjectLabelCollectCache): Promise<string> {
    const normalized = normalizeProjectLabel(project);
    if (projectKey(normalized) === projectKey(NO_PROJECT)) return NO_PROJECT;
    return (await this.collect(ownerId, cache)).grouped.get(projectKey(normalized))?.project ?? normalized;
  }

  private collect(ownerId: string, cache?: ProjectLabelCollectCache): Promise<CollectedProjectLabels> {
    if (!cache) return this.collectUncached(ownerId);
    if (cache.ownerId !== undefined && cache.ownerId !== ownerId) {
      throw new Error("project label cache cannot be shared between owners");
    }
    cache.ownerId = ownerId;
    cache.collected ??= this.collectUncached(ownerId);
    return cache.collected;
  }

  private async collectUncached(ownerId: string): Promise<CollectedProjectLabels> {
    const sourceLimit = assistantProjectSourceScanLimit + 1;
    const [ideas, tasks] = await Promise.all([
      this.ideas?.list(ownerId, undefined, { limit: sourceLimit, order: "created_asc" }) ?? [],
      this.tasks?.list(ownerId, undefined, { limit: sourceLimit, order: "created_asc" }) ?? [],
    ]);
    const sourceTruncated = ideas.length > assistantProjectSourceScanLimit || tasks.length > assistantProjectSourceScanLimit;
    const entries = [
      ...ideas.slice(0, assistantProjectSourceScanLimit).map((idea) => ({ project: idea.project, kind: "idea" as const, createdAt: idea.createdAt })),
      ...tasks.slice(0, assistantProjectSourceScanLimit).map((task) => ({ project: task.project, kind: "task" as const, createdAt: task.createdAt })),
    ].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.kind.localeCompare(right.kind));
    const grouped = new Map<string, AssistantProjectView>();
    for (const entry of entries) {
      const project = normalizeProjectLabel(entry.project);
      if (projectKey(project) === projectKey(NO_PROJECT)) continue;
      const key = projectKey(project);
      const existing = grouped.get(key) ?? { project, ideaCount: 0, taskCount: 0, totalCount: 0 };
      if (entry.kind === "idea") existing.ideaCount += 1;
      else existing.taskCount += 1;
      existing.totalCount += 1;
      grouped.set(key, existing);
    }
    return { grouped, sourceTruncated };
  }
}

export function normalizeProjectLabel(project: string): string {
  const normalized = project.trim().replace(/\s+/gu, " ");
  if (!normalized) throw new Error("project is required");
  return normalized;
}

function projectKey(project: string): string {
  return normalizeProjectLabel(project).toLocaleLowerCase("ru-RU");
}
