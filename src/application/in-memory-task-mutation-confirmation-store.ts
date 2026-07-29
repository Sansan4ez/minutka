import type { TaskStore } from "./task-store.js";
import {
  copyTaskMutationResult,
  normalizeTaskMutationProposal,
  taskActionKindMatchesProposal,
  taskMutationPayloadDigest,
  type PendingTaskMutation,
  type TaskMutationConfirmationRecord,
  type TaskMutationConfirmationStore,
} from "./task-mutation-confirmation.js";

/** Hermetic durable-state model: one lock per confirmation mirrors the SQL row lock. */
export function createInMemoryTaskMutationConfirmationStore(taskStore: TaskStore): TaskMutationConfirmationStore {
  const records = new Map<string, TaskMutationConfirmationRecord>();
  const locks = new Map<string, Promise<void>>();

  return {
    async save(record) {
      if (records.has(record.confirmationId)) throw new Error("confirmation id already exists");
      records.set(record.confirmationId, copyRecord(record));
    },
    async decide(input, effect) {
      return withKeyLock(locks, input.confirmationId, async () => {
        const record = records.get(input.confirmationId);
        if (!record) return { status: "not_found" };
        if (record.ownerId !== input.ownerId) return { status: "owner_mismatch" };
        if (!validCanonicalRecord(record)) return { status: "invalid_payload" };
        if (record.decision === "confirmed" && record.outcome) {
          return { status: "already_confirmed", outcome: copyTaskMutationResult(record.outcome) };
        }
        if (record.decision === "rejected") return { status: "already_rejected" };
        if (Date.parse(record.expiresAt) <= Date.parse(input.decidedAt)) return { status: "expired" };
        if (input.decision === "reject") {
          record.decision = "rejected";
          record.completedAt = input.decidedAt;
          records.set(record.confirmationId, record);
          return { status: "rejected" };
        }
        const outcome = await effect(taskStore, normalizeTaskMutationProposal(record.proposal));
        record.decision = "confirmed";
        record.outcome = copyTaskMutationResult(outcome);
        record.completedAt = input.decidedAt;
        records.set(record.confirmationId, record);
        return { status: "confirmed", outcome: copyTaskMutationResult(outcome) };
      });
    },
  };
}

function validCanonicalRecord(record: TaskMutationConfirmationRecord): boolean {
  try {
    const proposal = normalizeTaskMutationProposal(record.proposal);
    return taskActionKindMatchesProposal(record.actionKind, proposal)
      && taskMutationPayloadDigest(proposal) === record.payloadDigest;
  } catch {
    return false;
  }
}

function copyRecord(record: PendingTaskMutation): TaskMutationConfirmationRecord {
  return { ...record, proposal: normalizeTaskMutationProposal(record.proposal) };
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
