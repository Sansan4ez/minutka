import { assertUserId } from "./document-store.js";
import type { Clock } from "./runtime-primitives.js";
import type { AddIdeaInput, Idea, IdeaStore, UpdateIdeaInput } from "./idea-store.js";

/** Hermetic adapter for executable specs; production composition must use PostgreSQL. */
export function createInMemoryIdeaStore(clock: Clock): IdeaStore {
  const ideas = new Map<string, Idea>();
  const key = (userId: string, id: string) => `${assertUserId(userId)}\u0000${id}`;

  return {
    async add(input: AddIdeaInput) {
      const userId = assertUserId(input.userId);
      const now = clock.now();
      const idea: Idea = { ...input, userId, createdAt: now, lastActivityAt: now };
      ideas.set(key(userId, idea.id), idea);
      return { ...idea };
    },
    async list(userId, filter) {
      const safeUserId = assertUserId(userId);
      return [...ideas.values()]
        .filter((idea) =>
          idea.userId === safeUserId &&
          (!filter?.project || idea.project === filter.project) &&
          (!filter?.type || idea.type === filter.type) &&
          (!filter?.status || idea.status === filter.status),
        )
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
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
      const updated: Idea = { ...existing, ...patch, lastActivityAt: clock.now() };
      ideas.set(key(existing.userId, id), updated);
      return { ...updated };
    },
  };
}
