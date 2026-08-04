import type { Pool, PoolClient } from "pg";
import { mapPostgresError } from "../../application/persistence-error.js";
import {
  copyTaskMutationResult,
  normalizeTaskMutationProposal,
  taskActionKindMatchesProposal,
  taskMutationPayloadDigest,
  taskMutationProposalTaskId,
  type TaskMutationConfirmationRecord,
  type TaskMutationConfirmationStore,
  type TaskMutationProposal,
  type TaskPendingActionKind,
} from "../../application/task-mutation-confirmation.js";
import type { TaskMutationResult, TaskWriter } from "../../application/task-store.js";
import type { IdeaStatus } from "../../application/idea-store.js";
import type { Task } from "../../domain/task.js";
import { withTransaction } from "./postgres-pool.js";

const taskResultOutcomes = new Set(["created", "updated", "unchanged", "not_found", "conflict"]);

type Row = {
  confirmation_id: string;
  user_id: string;
  action_kind: string;
  payload: unknown;
  payload_digest: string;
  created_at: Date;
  expires_at: Date;
  completed_at: Date | null;
  decision: "confirmed" | "rejected" | null;
  outcome: unknown | null;
  before_task: unknown | null;
  undo_context: unknown | null;
  undo_expires_at: Date | null;
  undone_at: Date | null;
};

export function createPostgresTaskMutationConfirmationStore(pool: Pool): TaskMutationConfirmationStore {
  return {
    async save(record) {
      try {
        await pool.query(
          `INSERT INTO minutka_private.task_mutation_confirmations
            (confirmation_id,user_id,action_kind,payload,payload_digest,created_at,expires_at)
           VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)`,
          [record.confirmationId, record.ownerId, record.actionKind, JSON.stringify(record.proposal), record.payloadDigest, record.createdAt, record.expiresAt],
        );
      } catch (error) { throw mapPostgresError(error); }
    },
    async decide(input, effect) {
      try {
        return await withTransaction(pool, async (client) => {
          const selected = await client.query<Row>(
            "SELECT * FROM minutka_private.task_mutation_confirmations WHERE confirmation_id=$1 FOR UPDATE",
            [input.confirmationId],
          );
          const row = selected.rows[0];
          if (!row) return { result: { status: "not_found" } };
          if (row.user_id !== input.ownerId) return { result: { status: "owner_mismatch" } };
          const actionKind = row.action_kind as TaskPendingActionKind;
          const proposal = restoreCanonicalProposal(row);
          if (!proposal) return { result: { status: "invalid_payload" }, actionKind };
          const taskId = taskMutationProposalTaskId(proposal);
          if (row.decision === "confirmed" && row.outcome !== null) return { result: { status: "already_confirmed", outcome: restoreOutcome(row.outcome) }, actionKind, taskId };
          if (row.decision === "rejected") return { result: { status: "already_rejected" }, actionKind, taskId };
          if (row.completed_at !== null || row.outcome !== null) return { result: { status: "invalid_payload" }, actionKind };
          if (row.expires_at.getTime() <= Date.parse(input.decidedAt)) return { result: { status: "expired" }, actionKind };

          if (input.decision === "reject") {
            await client.query(
              `UPDATE minutka_private.task_mutation_confirmations
               SET completed_at=$2, decision='rejected'
               WHERE confirmation_id=$1`,
              [input.confirmationId, input.decidedAt],
            );
            return { result: { status: "rejected" }, actionKind, taskId };
          }

          const writer = taskStoreWithClient(client);
          const beforeTask = proposal.kind === "create" ? null : await writer.get(row.user_id, proposal.taskId);
          const ideaBeforeStatus = actionKind === "idea_to_task" && proposal.kind === "create" && proposal.input.originIdeaId
            ? await selectIdeaStatus(client, row.user_id, proposal.input.originIdeaId)
            : undefined;
          if (actionKind === "idea_to_task" && proposal.kind === "create" && proposal.input.originIdeaId && ideaBeforeStatus === "raw") {
            await client.query("UPDATE minutka_private.ideas SET status='planned', last_activity_at=now(), revision=revision+1 WHERE user_id=$1 AND idea_id=$2 AND deleted_at IS NULL", [row.user_id, proposal.input.originIdeaId]);
          }
          const outcome = await effect(writer, proposal);
          await client.query(
            `UPDATE minutka_private.task_mutation_confirmations
             SET completed_at=$2, decision='confirmed', outcome=$3::jsonb, before_task=$4::jsonb,
                 undo_context=$5::jsonb, undo_expires_at=$6
             WHERE confirmation_id=$1`,
            [input.confirmationId, input.decidedAt, JSON.stringify(outcome), beforeTask ? JSON.stringify(beforeTask) : null,
              ideaBeforeStatus ? JSON.stringify({ ideaBeforeStatus }) : null, actionKind === "cancel" ? null : input.undoExpiresAt ?? null],
          );
          return { result: { status: "confirmed", outcome: copyTaskMutationResult(outcome) }, actionKind, taskId };
        });
      } catch (error) { throw mapPostgresError(error); }
    },
    async undo(input, effect) {
      try {
        return await withTransaction(pool, async (client) => {
          const selected = await client.query<Row>(
            `SELECT * FROM minutka_private.task_mutation_confirmations
             WHERE user_id=$1 AND decision='confirmed' AND action_kind IN ('create','update','complete','idea_to_task')
             ORDER BY completed_at DESC, confirmation_id DESC LIMIT 1 FOR UPDATE`,
            [input.ownerId],
          );
          const row = selected.rows[0];
          if (!row) return { status: "not_found" };
          const record = restoreFullRecord(row);
          if (!record) return { status: "not_found" };
          const task = outcomeTask(record);
          if (row.undone_at) return task ? { status: "already_undone", actionKind: record.actionKind as Exclude<TaskPendingActionKind, "cancel">, task, ...(record.ideaBeforeStatus !== undefined ? { ideaStatusRestored: true } : {}) } : { status: "not_found" };
          if (!row.undo_expires_at || Date.parse(input.undoneAt) > row.undo_expires_at.getTime()) return { status: "expired" };
          const result = await effect(taskUndoWriterWithClient(client), record);
          if (result.status === "undone") {
            await client.query("UPDATE minutka_private.task_mutation_confirmations SET undone_at=$2 WHERE confirmation_id=$1", [row.confirmation_id, input.undoneAt]);
          }
          return result;
        });
      } catch (error) { throw mapPostgresError(error); }
    },
    async purge(input) {
      try {
        const result = await pool.query(
          `WITH candidates AS (
             SELECT confirmation_id
             FROM minutka_private.task_mutation_confirmations
             WHERE (completed_at IS NULL AND expires_at < $1)
                OR (completed_at IS NOT NULL AND completed_at < $2)
             ORDER BY COALESCE(completed_at, expires_at), confirmation_id
             LIMIT $3
             FOR UPDATE SKIP LOCKED
           )
           DELETE FROM minutka_private.task_mutation_confirmations confirmations
           USING candidates
           WHERE confirmations.confirmation_id = candidates.confirmation_id`,
          [input.pendingExpiredBefore, input.completedBefore, input.limit],
        );
        return result.rowCount ?? 0;
      } catch (error) { throw mapPostgresError(error); }
    },
  };
}

function restoreCanonicalProposal(row: Row): TaskMutationProposal | null {
  try {
    const proposal = normalizeTaskMutationProposal(row.payload as TaskMutationProposal);
    if (!taskActionKindMatchesProposal(row.action_kind as TaskPendingActionKind, proposal)) return null;
    if (taskMutationPayloadDigest(proposal) !== row.payload_digest) return null;
    return proposal;
  } catch {
    return null;
  }
}

function restoreFullRecord(row: Row): TaskMutationConfirmationRecord | null {
  const proposal = restoreCanonicalProposal(row);
  if (!proposal || !row.decision || !row.completed_at) return null;
  const undoContext = row.undo_context && typeof row.undo_context === "object" ? row.undo_context as { ideaBeforeStatus?: IdeaStatus } : undefined;
  return {
    confirmationId: row.confirmation_id,
    ownerId: row.user_id,
    actionKind: row.action_kind as TaskPendingActionKind,
    proposal,
    payloadDigest: row.payload_digest,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    decision: row.decision,
    completedAt: row.completed_at.toISOString(),
    ...(row.outcome ? { outcome: restoreOutcome(row.outcome) } : {}),
    ...(row.before_task ? { beforeTask: restoreStoredTask(row.before_task) } : {}),
    ...(undoContext?.ideaBeforeStatus ? { ideaBeforeStatus: undoContext.ideaBeforeStatus } : {}),
    ...(row.undo_expires_at ? { undoExpiresAt: row.undo_expires_at.toISOString() } : {}),
    ...(row.undone_at ? { undoneAt: row.undone_at.toISOString() } : {}),
  };
}

function taskStoreWithClient(client: Pick<PoolClient, "query">): TaskWriter & { get(userId: string, taskId: string): Promise<Task | null> } {
  return {
    async create(userId, input) {
      const inserted = await client.query<TaskRow>(
        `INSERT INTO minutka_private.tasks
          (task_id,user_id,title,project,record_type,status,due_date,origin_idea_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8)
         ON CONFLICT DO NOTHING RETURNING *`,
        [input.id, userId, input.title, input.project, input.type, input.status, input.dueDate ?? null, input.originIdeaId ?? null],
      );
      if (inserted.rows[0]) return { outcome: "created", task: restoreTask(inserted.rows[0]) };
      const byId = await client.query<TaskRow>("SELECT * FROM minutka_private.tasks WHERE task_id=$1", [input.id]);
      const byOrigin = input.originIdeaId === undefined || byId.rows[0]
        ? undefined
        : await client.query<TaskRow>("SELECT * FROM minutka_private.tasks WHERE user_id=$1 AND origin_idea_id=$2", [userId, input.originIdeaId]);
      const existing = byId.rows[0] ?? byOrigin?.rows[0];
      if (!existing || existing.user_id !== userId) return { outcome: "conflict" };
      const task = restoreTask(existing);
      return sameCreate(task, input) ? { outcome: "unchanged", task } : { outcome: "conflict", current: task };
    },
    async get(userId, taskId) {
      const selected = await client.query<TaskRow>("SELECT * FROM minutka_private.tasks WHERE user_id=$1 AND task_id=$2", [userId, taskId]);
      return selected.rows[0] ? restoreTask(selected.rows[0]) : null;
    },
    async update(userId, id, input) {
      const selected = await client.query<TaskRow>("SELECT * FROM minutka_private.tasks WHERE user_id=$1 AND task_id=$2 FOR UPDATE", [userId, id]);
      const row = selected.rows[0];
      if (!row) return { outcome: "not_found" };
      const task = restoreTask(row);
      if (task.revision !== input.expectedRevision) return { outcome: "conflict", current: task };
      if (Object.entries(input.patch).every(([key, value]) => key === "dueDate" && value === null ? task.dueDate === undefined : task[key as keyof Task] === value)) return { outcome: "unchanged", task };
      const fields = Object.entries(input.patch).filter(([, value]) => value !== undefined);
      const columns: Record<string, string> = { title: "title", project: "project", type: "record_type", status: "status", dueDate: "due_date" };
      const params: unknown[] = [userId, id, input.expectedRevision];
      const assignments = fields.map(([name, value]) => { params.push(value); return `${columns[name]}=$${params.length}${name === "dueDate" ? "::date" : ""}`; });
      const updated = await client.query<TaskRow>(`UPDATE minutka_private.tasks SET ${assignments.join(", ")}, updated_at=now(), revision=revision+1 WHERE user_id=$1 AND task_id=$2 AND revision=$3 RETURNING *`, params);
      return updated.rows[0] ? { outcome: "updated", task: restoreTask(updated.rows[0]) } : { outcome: "conflict", current: task };
    },
    async delete(userId, id, input) {
      const deleted = await client.query<TaskRow>("DELETE FROM minutka_private.tasks WHERE user_id=$1 AND task_id=$2 AND revision=$3 RETURNING *", [userId, id, input.expectedRevision]);
      if (deleted.rows[0]) return { outcome: "deleted", task: restoreTask(deleted.rows[0]) };
      const current = await client.query<TaskRow>("SELECT * FROM minutka_private.tasks WHERE user_id=$1 AND task_id=$2", [userId, id]);
      return current.rows[0] ? { outcome: "conflict", current: restoreTask(current.rows[0]) } : { outcome: "not_found" };
    },
  };
}

function taskUndoWriterWithClient(client: Pick<PoolClient, "query">) {
  return {
    ...taskStoreWithClient(client),
    async restoreIdeaStatus(userId: string, ideaId: string, status: IdeaStatus) {
      const updated = await client.query("UPDATE minutka_private.ideas SET status=$3, last_activity_at=now(), revision=revision+1 WHERE user_id=$1 AND idea_id=$2 AND deleted_at IS NULL", [userId, ideaId, status]);
      return (updated.rowCount ?? 0) > 0;
    },
  };
}

async function selectIdeaStatus(client: Pick<PoolClient, "query">, userId: string, ideaId: string): Promise<IdeaStatus | undefined> {
  const selected = await client.query<{ status: IdeaStatus }>("SELECT status FROM minutka_private.ideas WHERE user_id=$1 AND idea_id=$2", [userId, ideaId]);
  return selected.rows[0]?.status;
}

type TaskRow = {
  task_id: string; user_id: string; title: string; project: string; record_type: Task["type"]; status: Task["status"];
  due_date: string | Date | null; origin_idea_id: string | null; created_at: Date; updated_at: Date; revision: string | number;
};

function restoreTask(row: TaskRow): Task {
  return {
    id: row.task_id, userId: row.user_id, title: row.title, project: row.project, type: row.record_type, status: row.status,
    ...(row.due_date === null ? {} : { dueDate: postgresDate(row.due_date) }),
    ...(row.origin_idea_id === null ? {} : { originIdeaId: row.origin_idea_id }),
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), revision: Number(row.revision),
  };
}

function restoreStoredTask(value: unknown): Task {
  const task = value as Task;
  if (!task || typeof task !== "object" || typeof task.id !== "string" || typeof task.revision !== "number") throw new Error("invalid stored task undo snapshot");
  return { ...task };
}

function sameCreate(task: Task, input: Parameters<TaskWriter["create"]>[1]): boolean {
  return task.id === input.id && task.title === input.title && task.project === input.project && task.type === input.type
    && task.status === input.status && task.dueDate === input.dueDate && task.originIdeaId === input.originIdeaId;
}

function restoreOutcome(value: unknown): TaskMutationResult {
  if (!value || typeof value !== "object" || !taskResultOutcomes.has(String((value as { outcome?: unknown }).outcome))) throw new Error("invalid stored task mutation outcome");
  return copyTaskMutationResult(value as TaskMutationResult);
}

function outcomeTask(record: TaskMutationConfirmationRecord): Task | undefined {
  const outcome = record.outcome;
  return outcome && outcome.outcome !== "not_found" && outcome.outcome !== "conflict" ? outcome.task : undefined;
}

function postgresDate(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
