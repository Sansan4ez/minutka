import type { Task } from "../domain/task.js";
import { assertUserId } from "./document-store.js";
import type { Clock } from "./runtime-primitives.js";
import type {
  CreateTaskInput,
  TaskFilter,
  TaskMutationResult,
  TaskPatch,
  TaskStore,
} from "./task-store.js";

/** Hermetic adapter for executable specs; production composition must use PostgreSQL. */
export function createInMemoryTaskStore(clock: Clock): TaskStore {
  const tasks = new Map<string, Task>();
  const taskOwners = new Map<string, string>();
  const originIds = new Map<string, string>();
  const key = (userId: string, id: string) => `${assertUserId(userId)}\u0000${assertTaskId(id)}`;
  const originKey = (userId: string, originIdeaId: string) => `${assertUserId(userId)}\u0000${assertOriginIdeaId(originIdeaId)}`;

  return {
    async create(userId, input) {
      const safeUserId = assertUserId(userId);
      const normalized = normalizeCreateInput(input);
      const existingOwner = taskOwners.get(normalized.id);
      if (existingOwner !== undefined) {
        const existing = tasks.get(key(existingOwner, normalized.id))!;
        return existingOwner === safeUserId && sameCreateIntent(existing, normalized)
          ? unchanged(existing)
          : existingOwner === safeUserId
            ? { outcome: "conflict", current: copyTask(existing) }
            : { outcome: "conflict" };
      }
      if (normalized.originIdeaId !== undefined) {
        const existingId = originIds.get(originKey(safeUserId, normalized.originIdeaId));
        if (existingId !== undefined) {
          const existing = tasks.get(key(safeUserId, existingId))!;
          return sameCreateIntent(existing, normalized)
            ? unchanged(existing)
            : { outcome: "conflict", current: copyTask(existing) };
        }
      }
      const now = assertTimestamp(clock.now());
      const task: Task = { ...normalized, userId: safeUserId, createdAt: now, updatedAt: now, revision: 1 };
      tasks.set(key(safeUserId, task.id), task);
      taskOwners.set(task.id, safeUserId);
      if (task.originIdeaId !== undefined) originIds.set(originKey(safeUserId, task.originIdeaId), task.id);
      return { outcome: "created", task: copyTask(task) };
    },
    async get(userId, id) {
      const task = tasks.get(key(userId, id));
      return task === undefined ? null : copyTask(task);
    },
    async getByOriginIdeaId(userId, originIdeaId) {
      const safeUserId = assertUserId(userId);
      const taskId = originIds.get(originKey(safeUserId, originIdeaId));
      if (taskId === undefined) return null;
      const task = tasks.get(key(safeUserId, taskId));
      return task === undefined ? null : copyTask(task);
    },
    async list(userId, filter, options) {
      const safeUserId = assertUserId(userId);
      const limit = validateLimit(options?.limit);
      validateTaskFilter(filter);
      return [...tasks.values()]
        .filter((task) => task.userId === safeUserId && matchesFilter(task, filter))
        .sort(options?.order === "due_asc" ? compareDueDate : compareCreatedAt)
        .slice(0, limit)
        .map(copyTask);
    },
    async update(userId, id, input) {
      if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error("expectedRevision must be a positive safe integer");
      const taskKey = key(userId, id);
      const existing = tasks.get(taskKey);
      if (existing === undefined) return { outcome: "not_found" };
      if (existing.revision !== input.expectedRevision) return { outcome: "conflict", current: copyTask(existing) };
      const patch = normalizeTaskPatch(input.patch);
      if (samePatch(existing, patch)) return unchanged(existing);
      const { dueDate, ...fields } = patch;
      const updated: Task = {
        ...existing,
        ...fields,
        ...(typeof dueDate === "string" ? { dueDate } : {}),
        updatedAt: assertTimestamp(clock.now()),
        revision: existing.revision + 1,
      };
      if (dueDate === null) delete updated.dueDate;
      tasks.set(taskKey, updated);
      return { outcome: "updated", task: copyTask(updated) };
    },
  };
}

function normalizeCreateInput(input: CreateTaskInput): CreateTaskInput {
  return {
    ...input,
    id: assertTaskId(input.id),
    title: assertRequiredText(input.title, "title"),
    project: assertRequiredText(input.project, "project"),
    ...(input.dueDate === undefined ? {} : { dueDate: assertDueDate(input.dueDate) }),
    ...(input.originIdeaId === undefined ? {} : { originIdeaId: assertOriginIdeaId(input.originIdeaId) }),
  };
}

function normalizeTaskPatch(patch: TaskPatch): TaskPatch {
  const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as TaskPatch;
  return {
    ...defined,
    ...(defined.title === undefined ? {} : { title: assertRequiredText(defined.title, "title") }),
    ...(defined.project === undefined ? {} : { project: assertRequiredText(defined.project, "project") }),
    ...(defined.dueDate === undefined || defined.dueDate === null ? {} : { dueDate: assertDueDate(defined.dueDate) }),
  };
}

function validateTaskFilter(filter: TaskFilter | undefined): void {
  if (filter?.dueBefore !== undefined) assertDueDate(filter.dueBefore);
  if (filter?.dueAfter !== undefined) assertDueDate(filter.dueAfter);
}

function matchesFilter(task: Task, filter: TaskFilter | undefined): boolean {
  const statuses = Array.isArray(filter?.status) ? filter.status : filter?.status === undefined ? undefined : [filter.status];
  return (!filter?.project || task.project === filter.project)
    && (!filter?.type || task.type === filter.type)
    && (!statuses || statuses.includes(task.status))
    && (!filter?.dueBefore || (task.dueDate !== undefined && task.dueDate <= filter.dueBefore))
    && (!filter?.dueAfter || (task.dueDate !== undefined && task.dueDate >= filter.dueAfter));
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

function unchanged(task: Task): TaskMutationResult {
  return { outcome: "unchanged", task: copyTask(task) };
}

function compareCreatedAt(left: Task, right: Task): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function compareDueDate(left: Task, right: Task): number {
  if (left.dueDate === undefined && right.dueDate !== undefined) return 1;
  if (left.dueDate !== undefined && right.dueDate === undefined) return -1;
  return (left.dueDate ?? "").localeCompare(right.dueDate ?? "") || compareCreatedAt(left, right);
}

function assertRequiredText(value: string, field: string): string {
  if (!value.trim()) throw new Error(`${field} is required`);
  return value;
}

function assertTaskId(value: string): string {
  return assertRequiredText(value, "task id");
}

function assertOriginIdeaId(value: string): string {
  return assertRequiredText(value, "originIdeaId");
}

function assertDueDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new Error("dueDate must be an ISO calendar date");
  }
  return value;
}

function assertTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error("clock must return an ISO timestamp");
  return value;
}

function validateLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("limit must be a positive safe integer");
  return limit;
}

function copyTask(task: Task): Task {
  return { ...task };
}
