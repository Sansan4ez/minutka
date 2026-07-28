import type { Classified } from "./classification.js";

export type TaskStatus = "open" | "in_progress" | "done" | "cancelled";

/** An internal, owner-scoped planning record. Calendar integration is intentionally out of scope. */
export type Task = Classified & {
  id: string;
  userId: string;
  title: string;
  status: TaskStatus;
  /** Owner-local calendar date in ISO `YYYY-MM-DD` form. */
  dueDate?: string;
  /** Typed provenance only; creating a task never mutates the related idea. */
  originIdeaId?: string;
  createdAt: string;
  updatedAt: string;
  /** Monotonic compare-and-swap version. */
  revision: number;
};
