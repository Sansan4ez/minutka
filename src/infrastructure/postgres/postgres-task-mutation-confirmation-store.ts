import type { Pool, PoolClient } from "pg";
import { mapPostgresError } from "../../application/persistence-error.js";
import {
  copyTaskMutationResult,
  normalizeTaskMutationProposal,
  taskActionKindMatchesProposal,
  taskMutationPayloadDigest,
  type TaskMutationConfirmationStore,
  type TaskMutationProposal,
  type TaskPendingActionKind,
} from "../../application/task-mutation-confirmation.js";
import type { TaskMutationResult, TaskWriter } from "../../application/task-store.js";
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
          if (!row) return { status: "not_found" };
          if (row.user_id !== input.ownerId) return { status: "owner_mismatch" };
          const proposal = restoreCanonicalProposal(row);
          if (!proposal) return { status: "invalid_payload" };
          if (row.decision === "confirmed" && row.outcome !== null) return { status: "already_confirmed", outcome: restoreOutcome(row.outcome) };
          if (row.decision === "rejected") return { status: "already_rejected" };
          if (row.completed_at !== null || row.outcome !== null) return { status: "invalid_payload" };
          if (row.expires_at.getTime() <= Date.parse(input.decidedAt)) return { status: "expired" };

          if (input.decision === "reject") {
            await client.query(
              `UPDATE minutka_private.task_mutation_confirmations
               SET completed_at=$2, decision='rejected'
               WHERE confirmation_id=$1`,
              [input.confirmationId, input.decidedAt],
            );
            return { status: "rejected" };
          }

          const transactionalWriter: TaskWriter = {
            create: (ownerId, createInput) => taskStoreWithClient(client).create(ownerId, createInput),
            update: (ownerId, taskId, updateInput) => taskStoreWithClient(client).update(ownerId, taskId, updateInput),
          };
          const outcome = await effect(transactionalWriter, proposal);
          await client.query(
            `UPDATE minutka_private.task_mutation_confirmations
             SET completed_at=$2, decision='confirmed', outcome=$3::jsonb
             WHERE confirmation_id=$1`,
            [input.confirmationId, input.decidedAt, JSON.stringify(outcome)],
          );
          return { status: "confirmed", outcome: copyTaskMutationResult(outcome) };
        });
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

function taskStoreWithClient(client: Pick<PoolClient, "query">): TaskWriter {
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
    async update(userId, id, input) {
      const selected = await client.query<TaskRow>(
        "SELECT * FROM minutka_private.tasks WHERE user_id=$1 AND task_id=$2 FOR UPDATE",
        [userId, id],
      );
      const row = selected.rows[0];
      if (!row) return { outcome: "not_found" };
      const task = restoreTask(row);
      if (task.revision !== input.expectedRevision) return { outcome: "conflict", current: task };
      if (Object.entries(input.patch).every(([key, value]) => key === "dueDate" && value === null ? task.dueDate === undefined : task[key as keyof Task] === value)) {
        return { outcome: "unchanged", task };
      }
      const fields = Object.entries(input.patch).filter(([, value]) => value !== undefined);
      const columns: Record<string, string> = { title: "title", project: "project", type: "record_type", status: "status", dueDate: "due_date" };
      const params: unknown[] = [userId, id, input.expectedRevision];
      const assignments = fields.map(([name, value]) => {
        params.push(value);
        return `${columns[name]}=$${params.length}${name === "dueDate" ? "::date" : ""}`;
      });
      const updated = await client.query<TaskRow>(
        `UPDATE minutka_private.tasks SET ${assignments.join(", ")}, updated_at=now(), revision=revision+1
         WHERE user_id=$1 AND task_id=$2 AND revision=$3 RETURNING *`,
        params,
      );
      return updated.rows[0] ? { outcome: "updated", task: restoreTask(updated.rows[0]) } : { outcome: "conflict", current: task };
    },
  };
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

function sameCreate(task: Task, input: Parameters<TaskWriter["create"]>[1]): boolean {
  return task.id === input.id && task.title === input.title && task.project === input.project && task.type === input.type
    && task.status === input.status && task.dueDate === input.dueDate && task.originIdeaId === input.originIdeaId;
}

function restoreOutcome(value: unknown): TaskMutationResult {
  if (!value || typeof value !== "object" || !taskResultOutcomes.has(String((value as { outcome?: unknown }).outcome))) {
    throw new Error("invalid stored task mutation outcome");
  }
  return copyTaskMutationResult(value as TaskMutationResult);
}

function postgresDate(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10);
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
