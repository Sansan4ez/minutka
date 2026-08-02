import {
  contextDocumentPayloadDigest,
  copyContextDocumentOutcome,
  normalizeContextDocumentProposal,
  type ContextDocumentConfirmationStore,
  type PendingContextDocumentMutation,
  type PendingContextDocumentMutationRecord,
} from "./context-document-service.js";

/** Hermetic exact-once confirmation model with one lock per opaque id. */
export function createInMemoryContextDocumentConfirmationStore(): ContextDocumentConfirmationStore {
  const records = new Map<string, PendingContextDocumentMutationRecord>();
  const locks = new Map<string, Promise<void>>();
  return {
    async save(record) {
      if (records.has(record.confirmationId)) throw new Error("confirmation id already exists");
      records.set(record.confirmationId, copyRecord(record));
    },
    async decide(input, effect) {
      return withKeyLock(locks, input.confirmationId, async () => {
        const record = records.get(input.confirmationId);
        if (!record) return { result: { status: "not_found" } };
        if (record.ownerId !== input.ownerId) return { result: { status: "owner_mismatch" } };
        let proposal;
        try {
          proposal = normalizeContextDocumentProposal(record.proposal);
          if (contextDocumentPayloadDigest(proposal) !== record.payloadDigest) return { result: { status: "invalid_payload" }, proposal };
        } catch { return { result: { status: "invalid_payload" } }; }
        if (record.decision === "confirmed" && record.outcome) return { result: { status: "already_confirmed", outcome: copyContextDocumentOutcome(record.outcome) }, proposal };
        if (record.decision === "rejected") return { result: { status: "already_rejected" }, proposal };
        if (Date.parse(record.expiresAt) <= Date.parse(input.decidedAt)) return { result: { status: "expired" }, proposal };
        if (input.decision === "reject") {
          record.decision = "rejected";
          record.completedAt = input.decidedAt;
          records.set(record.confirmationId, record);
          return { result: { status: "rejected" }, proposal };
        }
        const outcome = await effect(proposal);
        record.decision = "confirmed";
        record.outcome = copyContextDocumentOutcome(outcome);
        record.completedAt = input.decidedAt;
        records.set(record.confirmationId, record);
        return { result: { status: "confirmed", outcome: copyContextDocumentOutcome(outcome) }, proposal };
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

function copyRecord(record: PendingContextDocumentMutation): PendingContextDocumentMutationRecord {
  return { ...record, proposal: normalizeContextDocumentProposal(record.proposal) };
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
