import { assertUserId } from "./document-store.js";
import type { Clock } from "./runtime-primitives.js";
import { definedIdeaPatch, validateIdeaText, type AddIdeaInput, type Idea, type IdeaStore, type UpdateIdeaInput } from "./idea-store.js";

/** Hermetic adapter for executable specs; production composition must use PostgreSQL. */
export function createInMemoryIdeaStore(clock: Clock): IdeaStore {
  const ideas = new Map<string, Idea>();
  const key = (userId: string, id: string) => `${assertUserId(userId)}\u0000${id}`;
  const globalIds = new Set<string>();

  return {
    async add(input: AddIdeaInput) {
      const userId = assertUserId(input.userId);
      validateIdeaText(input.project, "project");
      validateIdeaText(input.summary, "summary");
      if (input.source?.kind === "text" && !input.source.text.trim()) throw new Error("source text is required");
      if (input.source?.kind === "blob" && !input.source.blobKey.trim()) throw new Error("source blob key is required");
      if (globalIds.has(input.id)) throw new Error("idea id already exists");
      const now = clock.now();
      const idea: Idea = { ...input, userId, createdAt: now, lastActivityAt: now };
      ideas.set(key(userId, idea.id), idea);
      globalIds.add(idea.id);
      return { ...idea };
    },
    async list(userId, filter, options) {
      const safeUserId = assertUserId(userId);
      const limit = validateLimit(options?.limit);
      return [...ideas.values()]
        .filter((idea) =>
          idea.userId === safeUserId &&
          (!filter?.project || idea.project === filter.project) &&
          (!filter?.type || idea.type === filter.type) &&
          (!filter?.status || idea.status === filter.status),
        )
        .sort((left, right) => options?.order === "activity_desc"
          ? right.lastActivityAt.localeCompare(left.lastActivityAt) || right.id.localeCompare(left.id)
          : left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
        .slice(0, limit)
        .map((idea) => ({ ...idea }));
    },
    async stale(userId, days) {
      const safeUserId = assertUserId(userId);
      if (!Number.isFinite(days) || days < 0) throw new Error("days must be a non-negative finite number");
      const threshold = new Date(Date.parse(clock.now()) - days * 86_400_000).toISOString();
      return [...ideas.values()]
        .filter((idea) => idea.userId === safeUserId && (idea.status === "raw" || idea.status === "discussed") && idea.lastActivityAt <= threshold)
        .sort((left, right) => left.lastActivityAt.localeCompare(right.lastActivityAt) || left.id.localeCompare(right.id))
        .map((idea) => ({ ...idea }));
    },
    async update(userId, id, patch: UpdateIdeaInput) {
      const existing = ideas.get(key(userId, id));
      if (!existing) return null;
      const updated: Idea = { ...existing, ...definedIdeaPatch(patch), lastActivityAt: clock.now() };
      ideas.set(key(existing.userId, id), updated);
      return { ...updated };
    },
  };
}

function validateLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("limit must be a positive safe integer");
  return limit;
}
