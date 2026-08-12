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
      const idea: Idea = { ...input, userId, createdAt: now, lastActivityAt: now, revision: 1 };
      ideas.set(key(userId, idea.id), idea);
      globalIds.add(idea.id);
      return { ...idea };
    },
    async get(userId, id) {
      const idea = ideas.get(key(userId, id));
      return idea === undefined || idea.deletedAt !== undefined ? null : { ...idea };
    },
    async list(userId, filter, options) {
      const safeUserId = assertUserId(userId);
      const limit = validateLimit(options?.limit);
      return [...ideas.values()]
        .filter((idea) =>
          idea.userId === safeUserId &&
          (options?.includeDeleted === true || idea.deletedAt === undefined) &&
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
        .filter((idea) => idea.userId === safeUserId && idea.deletedAt === undefined && (idea.status === "raw" || idea.status === "discussed") && idea.lastActivityAt <= threshold)
        .sort((left, right) => left.lastActivityAt.localeCompare(right.lastActivityAt) || left.id.localeCompare(right.id))
        .map((idea) => ({ ...idea }));
    },
    async update(userId, id, patch: UpdateIdeaInput) {
      const existing = ideas.get(key(userId, id));
      if (!existing || existing.deletedAt !== undefined) return null;
      const defined = definedIdeaPatch(patch);
      const updated: Idea = Object.keys(defined).length === 0
        ? existing
        : { ...existing, ...defined, lastActivityAt: clock.now(), revision: existing.revision + 1 };
      ideas.set(key(existing.userId, id), updated);
      return { ...updated };
    },
    async append(userId, id, input) {
      const existing = ideas.get(key(userId, id));
      if (!existing || existing.deletedAt !== undefined) return { status: "not_found" };
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision <= 0) throw new Error("expectedRevision must be a positive safe integer");
      const text = input.text.trim();
      if (!text) throw new Error("append text is required");
      if (existing.revision !== input.expectedRevision) return { status: "conflict", current: { ...existing } };
      const updated: Idea = {
        ...existing,
        summary: appendIdeaSummary(existing.summary, text),
        lastActivityAt: clock.now(),
        revision: existing.revision + 1,
      };
      ideas.set(key(existing.userId, id), updated);
      return { status: "applied", idea: { ...updated } };
    },
    async softDelete(userId, id, input) {
      const existing = ideas.get(key(userId, id));
      if (!existing) return { outcome: "not_found" };
      if (existing.deletedAt !== undefined) return { outcome: "already_deleted", idea: { ...existing } };
      if (input.expectedRevision !== undefined && input.expectedRevision !== existing.revision) return { outcome: "conflict", current: { ...existing } };
      const updated: Idea = {
        ...existing,
        deletedAt: input.deletedAt,
        undoExpiresAt: input.undoExpiresAt,
        lastActivityAt: input.deletedAt,
        revision: existing.revision + 1,
      };
      ideas.set(key(existing.userId, id), updated);
      return { outcome: "deleted", idea: { ...updated } };
    },
    async undoDelete(userId, id, input) {
      const existing = ideas.get(key(userId, id));
      if (!existing) return { outcome: "not_found" };
      if (existing.deletedAt === undefined) return { outcome: "unchanged", idea: { ...existing } };
      if (input.expectedRevision !== undefined && input.expectedRevision !== existing.revision) return { outcome: "conflict", current: { ...existing } };
      if (existing.undoExpiresAt === undefined || Date.parse(input.restoredAt) > Date.parse(existing.undoExpiresAt)) return { outcome: "expired" };
      const { deletedAt: _deletedAt, undoExpiresAt: _undoExpiresAt, ...active } = existing;
      const updated: Idea = { ...active, lastActivityAt: input.restoredAt, revision: existing.revision + 1 };
      ideas.set(key(existing.userId, id), updated);
      return { outcome: "restored", idea: { ...updated } };
    },
  };
}

function appendIdeaSummary(summary: string, text: string): string {
  const existing = summary.trimEnd();
  return existing ? `${existing}\n\n${text}` : text;
}

function validateLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("limit must be a positive safe integer");
  return limit;
}
