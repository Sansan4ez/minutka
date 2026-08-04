import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import { assertUserId } from "../../application/document-store.js";
import { mapPostgresError } from "../../application/persistence-error.js";
import { normalizeTaskPatch } from "../../application/task-store.js";
import type {
  CreateTaskInput,
  TaskFilter,
  TaskPatch,
  TaskStore,
} from "../../application/task-store.js";
import type { Task } from "../../domain/task.js";
import { withTransaction } from "./postgres-pool.js";

const taskSchema = z.strictObject({
  id: z.string().min(1),
  userId: z.string().min(1),
  title: z.string().min(1),
  project: z.string().min(1),
  type: z.enum(["money", "development", "content", "people", "operations", "knowledge", "personal"]),
  status: z.enum(["open", "in_progress", "done", "cancelled"]),
  dueDate: z.iso.date().optional(),
  originIdeaId: z.string().min(1).optional(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  revision: z.number().int().positive(),
});

type Row = {
  task_id: string;
  user_id: string;
  title: string;
  project: string;
  record_type: string;
  status: string;
  due_date: string | Date | null;
  origin_idea_id: string | null;
  created_at: Date;
  updated_at: Date;
  revision: string | number;
};

type Queryable = Pick<Pool | PoolClient, "query">;

function restoreTask(row: Row): Task {
  return taskSchema.parse({
    id: row.task_id,
    userId: row.user_id,
    title: row.title,
    project: row.project,
    type: row.record_type,
    status: row.status,
    ...(row.due_date === null ? {} : { dueDate: postgresDate(row.due_date) }),
    ...(row.origin_idea_id === null ? {} : { originIdeaId: row.origin_idea_id }),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    revision: Number(row.revision),
  });
}

export function createPostgresTaskStore(pool: Pool): TaskStore {
  return {
    async create(userId, input) {
      const safeUserId = assertUserId(userId);
      const normalized = normalizeCreateInput(input);
      try {
        return await withTransaction(pool, async (client) => {
          const inserted = await client.query<Row>(
            `INSERT INTO minutka_private.tasks
              (task_id,user_id,title,project,record_type,status,due_date,origin_idea_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7::date,$8)
             ON CONFLICT DO NOTHING
             RETURNING *`,
            [normalized.id, safeUserId, normalized.title, normalized.project, normalized.type,
              normalized.status, normalized.dueDate ?? null, normalized.originIdeaId ?? null],
          );
          if (inserted.rows[0]) return { outcome: "created", task: restoreTask(inserted.rows[0]) };

          const existing = await findCreateConflict(client, safeUserId, normalized);
          if (!existing || existing.user_id !== safeUserId) return { outcome: "conflict" };
          const task = restoreTask(existing);
          return sameCreateIntent(task, normalized)
            ? { outcome: "unchanged", task }
            : { outcome: "conflict", current: task };
        });
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async get(userId, id) {
      const safeUserId = assertUserId(userId);
      const safeId = assertRequiredText(id, "task id");
      try {
        const result = await pool.query<Row>(
          "SELECT * FROM minutka_private.tasks WHERE user_id=$1 AND task_id=$2",
          [safeUserId, safeId],
        );
        return result.rows[0] ? restoreTask(result.rows[0]) : null;
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async getByOriginIdeaId(userId, originIdeaId) {
      const safeUserId = assertUserId(userId);
      const safeOriginIdeaId = assertRequiredText(originIdeaId, "originIdeaId");
      try {
        const result = await pool.query<Row>(
          "SELECT * FROM minutka_private.tasks WHERE user_id=$1 AND origin_idea_id=$2",
          [safeUserId, safeOriginIdeaId],
        );
        return result.rows[0] ? restoreTask(result.rows[0]) : null;
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async list(userId, filter, options) {
      const safeUserId = assertUserId(userId);
      validateTaskFilter(filter);
      const clauses = ["user_id=$1"];
      const params: unknown[] = [safeUserId];
      if (filter?.project !== undefined) {
        params.push(filter.project);
        clauses.push(`project=$${params.length}`);
      }
      if (filter?.type !== undefined) {
        params.push(filter.type);
        clauses.push(`record_type=$${params.length}`);
      }
      if (filter?.status !== undefined) {
        const statuses = Array.isArray(filter.status) ? [...filter.status] : [filter.status];
        params.push(statuses);
        clauses.push(`status = ANY($${params.length}::text[])`);
      }
      if (filter?.dueBefore !== undefined) {
        params.push(filter.dueBefore);
        clauses.push(`due_date <= $${params.length}::date`);
      }
      if (filter?.dueAfter !== undefined) {
        params.push(filter.dueAfter);
        clauses.push(`due_date >= $${params.length}::date`);
      }
      const limit = validateLimit(options?.limit);
      if (limit !== undefined) params.push(limit);
      const order = options?.order === "due_asc"
        ? "due_date ASC NULLS LAST, created_at ASC, task_id ASC"
        : "created_at ASC, task_id ASC";
      const limitClause = limit === undefined ? "" : ` LIMIT $${params.length}`;
      try {
        const result = await pool.query<Row>(
          `SELECT * FROM minutka_private.tasks WHERE ${clauses.join(" AND ")} ORDER BY ${order}${limitClause}`,
          params,
        );
        return result.rows.map(restoreTask);
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async update(userId, id, input) {
      const safeUserId = assertUserId(userId);
      const safeId = assertRequiredText(id, "task id");
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
        throw new Error("expectedRevision must be a positive safe integer");
      }
      const patch = normalizeTaskPatch(input.patch);
      try {
        return await withTransaction(pool, async (client) => {
          const current = await client.query<Row>(
            "SELECT * FROM minutka_private.tasks WHERE user_id=$1 AND task_id=$2 FOR UPDATE",
            [safeUserId, safeId],
          );
          if (!current.rows[0]) return { outcome: "not_found" };
          const task = restoreTask(current.rows[0]);
          if (task.revision !== input.expectedRevision) return { outcome: "conflict", current: task };
          if (samePatch(task, patch)) return { outcome: "unchanged", task };

          const fields = Object.entries(patch);
          const columns: Record<string, string> = {
            title: "title",
            project: "project",
            type: "record_type",
            status: "status",
            dueDate: "due_date",
          };
          const params: unknown[] = [safeUserId, safeId, input.expectedRevision];
          const assignments = fields.map(([name, value]) => {
            params.push(value);
            return `${columns[name]}=$${params.length}${name === "dueDate" ? "::date" : ""}`;
          });
          const updated = await client.query<Row>(
            `UPDATE minutka_private.tasks
             SET ${assignments.join(", ")}, updated_at=now(), revision=revision+1
             WHERE user_id=$1 AND task_id=$2 AND revision=$3
             RETURNING *`,
            params,
          );
          if (!updated.rows[0]) return { outcome: "conflict", current: task };
          return { outcome: "updated", task: restoreTask(updated.rows[0]) };
        });
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async delete(userId, id, input) {
      const safeUserId = assertUserId(userId);
      const safeId = assertRequiredText(id, "task id");
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
        throw new Error("expectedRevision must be a positive safe integer");
      }
      try {
        const deleted = await pool.query<Row>(
          "DELETE FROM minutka_private.tasks WHERE user_id=$1 AND task_id=$2 AND revision=$3 RETURNING *",
          [safeUserId, safeId, input.expectedRevision],
        );
        if (deleted.rows[0]) return { outcome: "deleted", task: restoreTask(deleted.rows[0]) };
        const current = await pool.query<Row>("SELECT * FROM minutka_private.tasks WHERE user_id=$1 AND task_id=$2", [safeUserId, safeId]);
        return current.rows[0] ? { outcome: "conflict", current: restoreTask(current.rows[0]) } : { outcome: "not_found" };
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
  };
}

async function findCreateConflict(client: Queryable, userId: string, input: CreateTaskInput): Promise<Row | undefined> {
  const byId = await client.query<Row>(
    "SELECT * FROM minutka_private.tasks WHERE task_id=$1",
    [input.id],
  );
  if (byId.rows[0]) return byId.rows[0];
  if (input.originIdeaId === undefined) return undefined;
  const byOrigin = await client.query<Row>(
    "SELECT * FROM minutka_private.tasks WHERE user_id=$1 AND origin_idea_id=$2",
    [userId, input.originIdeaId],
  );
  return byOrigin.rows[0];
}

function normalizeCreateInput(input: CreateTaskInput): CreateTaskInput {
  return {
    ...input,
    id: assertRequiredText(input.id, "task id"),
    title: assertRequiredText(input.title, "title"),
    project: assertRequiredText(input.project, "project"),
    ...(input.dueDate === undefined ? {} : { dueDate: assertDueDate(input.dueDate) }),
    ...(input.originIdeaId === undefined ? {} : { originIdeaId: assertRequiredText(input.originIdeaId, "originIdeaId") }),
  };
}

function validateTaskFilter(filter: TaskFilter | undefined): void {
  if (filter?.dueBefore !== undefined) assertDueDate(filter.dueBefore);
  if (filter?.dueAfter !== undefined) assertDueDate(filter.dueAfter);
}

function sameCreateIntent(task: Task, input: CreateTaskInput): boolean {
  return task.id === input.id
    && task.title === input.title
    && task.project === input.project
    && task.type === input.type
    && task.status === input.status
    && task.dueDate === input.dueDate
    && task.originIdeaId === input.originIdeaId;
}

function samePatch(task: Task, patch: TaskPatch): boolean {
  return Object.entries(patch).every(([name, value]) => name === "dueDate" && value === null
    ? task.dueDate === undefined
    : task[name as keyof Task] === value);
}

function assertRequiredText(value: string, field: string): string {
  if (!value.trim()) throw new Error(`${field} is required`);
  return value;
}

function assertDueDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new Error("dueDate must be an ISO calendar date");
  }
  return value;
}

function validateLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("limit must be a positive safe integer");
  return limit;
}

function postgresDate(value: string | Date): string {
  if (typeof value === "string") return value.slice(0, 10);
  // node-postgres parses PostgreSQL `date` at local midnight. Read local
  // calendar fields so converting to UTC cannot shift the owner-local date.
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
}
