import type { IdeaStore } from "./idea-store.js";
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
export function createInMemoryTaskMutationConfirmationStore(taskStore: TaskStore, ideas?: Pick<IdeaStore, "get" | "update">): TaskMutationConfirmationStore {
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
        record.beforeTask = record.proposal.kind === "create" ? undefined : await taskStore.get(record.ownerId, record.proposal.taskId) ?? undefined;
        if (record.actionKind === "idea_to_task" && record.proposal.kind === "create" && record.proposal.input.originIdeaId && ideas) {
          const idea = await ideas.get(record.ownerId, record.proposal.input.originIdeaId);
          record.ideaBeforeStatus = idea?.status;
          if (idea?.status === "raw") await ideas.update(record.ownerId, idea.id, { status: "planned" });
        }
        const outcome = await effect(taskStore, normalizeTaskMutationProposal(record.proposal));
        record.decision = "confirmed";
        record.outcome = copyTaskMutationResult(outcome);
        record.completedAt = input.decidedAt;
        if (record.actionKind !== "cancel" && input.undoExpiresAt) record.undoExpiresAt = input.undoExpiresAt;
        records.set(record.confirmationId, record);
        return { result: { status: "confirmed", outcome: copyTaskMutationResult(outcome) }, actionKind: record.actionKind, taskId };
      });
    },
    async undo(input, effect) {
      const candidate = [...records.values()]
        .filter((record) => record.ownerId === input.ownerId && record.decision === "confirmed" && record.actionKind !== "cancel")
        .sort((left, right) => (right.completedAt ?? "").localeCompare(left.completedAt ?? "") || right.confirmationId.localeCompare(left.confirmationId))[0];
      if (!candidate) return { status: "not_found" };
      return withKeyLock(locks, candidate.confirmationId, async () => {
        const record = records.get(candidate.confirmationId)!;
        const task = outcomeTask(record);
        if (record.undoneAt) return task ? { status: "already_undone", actionKind: record.actionKind as Exclude<typeof record.actionKind, "cancel">, task, ...(record.ideaBeforeStatus !== undefined ? { ideaStatusRestored: true } : {}) } : { status: "not_found" };
        if (!record.undoExpiresAt || Date.parse(input.undoneAt) > Date.parse(record.undoExpiresAt)) return { status: "expired" };
        const result = await effect({
          ...taskStore,
          get: taskStore.get.bind(taskStore),
          restoreIdeaStatus: async (ownerId, ideaId, status) => {
            if (!ideas) return false;
            const idea = await ideas.get(ownerId, ideaId);
            if (!idea) return false;
            const restored = await ideas.update(ownerId, ideaId, { status });
            return restored?.status === status;
          },
        }, copyFullRecord(record));
        if (result.status === "undone") {
          record.undoneAt = input.undoneAt;
          records.set(record.confirmationId, record);
        }
        return result;
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

function outcomeTask(record: TaskMutationConfirmationRecord) {
  const outcome = record.outcome;
  return outcome && outcome.outcome !== "not_found" && outcome.outcome !== "conflict" ? { ...outcome.task } : undefined;
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

function copyFullRecord(record: TaskMutationConfirmationRecord): TaskMutationConfirmationRecord {
  return {
    ...record,
    proposal: normalizeTaskMutationProposal(record.proposal),
    ...(record.outcome ? { outcome: copyTaskMutationResult(record.outcome) } : {}),
    ...(record.beforeTask ? { beforeTask: { ...record.beforeTask } } : {}),
  };
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
