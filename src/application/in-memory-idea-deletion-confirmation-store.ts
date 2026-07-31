import {
  copyIdeaMutationResult,
  normalizeProposal,
  type IdeaDeletionConfirmationRecord,
  type IdeaDeletionConfirmationStore,
  type PendingIdeaDeletion,
} from "./idea-deletion.js";
import type { IdeaStore } from "./idea-store.js";

/** Hermetic durable-state model: one lock per confirmation mirrors the SQL row lock. */
export function createInMemoryIdeaDeletionConfirmationStore(ideas: IdeaStore): IdeaDeletionConfirmationStore {
  const records = new Map<string, IdeaDeletionConfirmationRecord>();
  const locks = new Map<string, Promise<void>>();

  return {
    async save(record) {
      if (records.has(record.confirmationId)) throw new Error("confirmation id already exists");
      records.set(record.confirmationId, copyRecord(record));
    },
    async decide(input) {
      return withKeyLock(locks, input.confirmationId, async () => {
        const record = records.get(input.confirmationId);
        if (!record || record.ownerId !== input.ownerId) return { result: { status: "not_found" } };
        let proposal;
        try { proposal = normalizeProposal(record.proposal); }
        catch { return { result: { status: "invalid_payload" } }; }
        if (record.decision === "confirmed" && record.outcome) {
          return { result: { status: "already_confirmed", outcome: copyIdeaMutationResult(record.outcome) }, ideaId: proposal.ideaId };
        }
        if (record.decision === "rejected") return { result: { status: "already_rejected" }, ideaId: proposal.ideaId };
        if (Date.parse(record.expiresAt) <= Date.parse(input.decidedAt)) return { result: { status: "expired" }, ideaId: proposal.ideaId };
        if (input.decision === "reject") {
          record.decision = "rejected";
          record.completedAt = input.decidedAt;
          records.set(record.confirmationId, record);
          return { result: { status: "rejected" }, ideaId: proposal.ideaId };
        }
        const outcome = await ideas.softDelete(input.ownerId, proposal.ideaId, {
          expectedRevision: proposal.expectedRevision,
          deletedAt: input.decidedAt,
          undoExpiresAt: input.undoExpiresAt,
        });
        record.decision = "confirmed";
        record.outcome = copyIdeaMutationResult(outcome);
        record.completedAt = input.decidedAt;
        records.set(record.confirmationId, record);
        return { result: { status: "confirmed", outcome: copyIdeaMutationResult(outcome) }, ideaId: proposal.ideaId };
      });
    },
    async purge(input) {
      const candidates = [...records.values()]
        .filter((record) => record.completedAt
          ? Date.parse(record.completedAt) < Date.parse(input.completedBefore)
          : Date.parse(record.expiresAt) < Date.parse(input.pendingExpiredBefore))
        .sort((left, right) => Date.parse(left.completedAt ?? left.expiresAt) - Date.parse(right.completedAt ?? right.expiresAt)
          || left.confirmationId.localeCompare(right.confirmationId))
        .slice(0, input.limit);
      for (const record of candidates) records.delete(record.confirmationId);
      return candidates.length;
    },
  };
}

function copyRecord(record: PendingIdeaDeletion): IdeaDeletionConfirmationRecord {
  return { ...record, proposal: normalizeProposal(record.proposal) };
}

async function withKeyLock<T>(locks: Map<string, Promise<void>>, key: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  locks.set(key, queued);
  await previous;
  try { return await action(); }
  finally {
    release();
    if (locks.get(key) === queued) locks.delete(key);
  }
}
