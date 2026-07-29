import type { TaskStore } from "./task-store.js";
import {
  copyTaskMutationResult,
  normalizeTaskMutationProposal,
  taskActionKindMatchesProposal,
  taskMutationPayloadDigest,
  taskMutationProposalTaskId,
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
        if (!record) return { result: { status: "not_found" } };
        if (record.ownerId !== input.ownerId) return { result: { status: "owner_mismatch" } };
        if (!validCanonicalRecord(record)) return { result: { status: "invalid_payload" }, actionKind: record.actionKind };
        const taskId = taskMutationProposalTaskId(record.proposal);
        if (record.decision === "confirmed" && record.outcome) {
          return { result: { status: "already_confirmed", outcome: copyTaskMutationResult(record.outcome) }, actionKind: record.actionKind, taskId };
        }
        if (record.decision === "rejected") return { result: { status: "already_rejected" }, actionKind: record.actionKind, taskId };
        if (Date.parse(record.expiresAt) <= Date.parse(input.decidedAt)) return { result: { status: "expired" }, actionKind: record.actionKind };
        if (input.decision === "reject") {
          record.decision = "rejected";
          record.completedAt = input.decidedAt;
          records.set(record.confirmationId, record);
          return { result: { status: "rejected" }, actionKind: record.actionKind, taskId };
        }
        const outcome = await effect(taskStore, normalizeTaskMutationProposal(record.proposal));
        record.decision = "confirmed";
        record.outcome = copyTaskMutationResult(outcome);
        record.completedAt = input.decidedAt;
        records.set(record.confirmationId, record);
        return { result: { status: "confirmed", outcome: copyTaskMutationResult(outcome) }, actionKind: record.actionKind, taskId };
      });
    },
    async purge(input) {
      const candidates = [...records.values()]
        .filter((record) => record.completedAt
          ? Date.parse(record.completedAt) < Date.parse(input.completedBefore)
          : Date.parse(record.expiresAt) < Date.parse(input.pendingExpiredBefore))
        .sort((left, right) => {
          const leftTime = Date.parse(left.completedAt ?? left.expiresAt);
          const rightTime = Date.parse(right.completedAt ?? right.expiresAt);
          return leftTime - rightTime || left.confirmationId.localeCompare(right.confirmationId);
        })
        .slice(0, input.limit);
      for (const record of candidates) records.delete(record.confirmationId);
      return candidates.length;
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
