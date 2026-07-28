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

export type TaskMutationResult =
  | { outcome: "created" | "updated"; task: Task }
  | { outcome: "unchanged"; task: Task }
  | { outcome: "not_found" }
  | { outcome: "conflict"; current?: Task };

/** Read-only owner-scoped task boundary. */
export interface TaskReader {
  get(userId: string, id: string): Promise<Task | null>;
  list(userId: string, filter?: TaskFilter, options?: TaskListOptions): Promise<Task[]>;
}

/** Mutations remain behind application use-cases and explicit confirmation. */
export interface TaskWriter {
  create(userId: string, input: CreateTaskInput): Promise<TaskMutationResult>;
  update(userId: string, id: string, input: UpdateTaskInput): Promise<TaskMutationResult>;
}

export type TaskStore = TaskReader & TaskWriter;
