import type { Classified } from "../domain/classification.js";
import type { Task, TaskStatus } from "../domain/task.js";

/** The authenticated application boundary supplies userId; model/tool payloads must not. */
export type CreateTaskInput = Omit<Task, "userId" | "createdAt" | "updatedAt" | "revision">;

export type TaskFilter = Partial<Classified> & {
  status?: TaskStatus | readonly TaskStatus[];
  dueBefore?: string;
  dueAfter?: string;
};

export type TaskListOptions = {
  limit?: number;
  order?: "created_asc" | "due_asc";
};

export type TaskPatch = Partial<Pick<Task, "title" | "project" | "type" | "status">> & {
  /** Null explicitly clears the optional date; undefined is ignored. */
  dueDate?: string | null;
};

export type UpdateTaskInput = {
  patch: TaskPatch;
  expectedRevision: number;
};

/** Removes ignored undefined fields and rejects patches with no effective mutation. */
export function normalizeTaskPatch(patch: TaskPatch): TaskPatch {
  const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as TaskPatch;
  if (Object.keys(defined).length === 0) throw new Error("Task patch must not be empty");
  return {
    ...defined,
    ...(defined.title === undefined ? {} : { title: assertRequiredText(defined.title, "title") }),
    ...(defined.project === undefined ? {} : { project: assertRequiredText(defined.project, "project") }),
    ...(defined.dueDate === undefined || defined.dueDate === null ? {} : { dueDate: assertDueDate(defined.dueDate) }),
  };
}

export type TaskMutationResult =
  | { outcome: "created" | "updated"; task: Task }
  | { outcome: "unchanged"; task: Task }
  | { outcome: "not_found" }
  | { outcome: "conflict"; current?: Task };

/** Read-only owner-scoped task boundary. */
export interface TaskReader {
  get(userId: string, id: string): Promise<Task | null>;
  getByOriginIdeaId(userId: string, originIdeaId: string): Promise<Task | null>;
  list(userId: string, filter?: TaskFilter, options?: TaskListOptions): Promise<Task[]>;
}

/** Mutations remain behind application use-cases and explicit confirmation. */
export interface TaskWriter {
  create(userId: string, input: CreateTaskInput): Promise<TaskMutationResult>;
  update(userId: string, id: string, input: UpdateTaskInput): Promise<TaskMutationResult>;
}

export type TaskStore = TaskReader & TaskWriter;

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
