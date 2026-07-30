import type { Task } from "../domain/task.js";
import type { IdeaToTaskService } from "./idea-to-task.js";
import { pendingTaskReceipt, type PendingTaskMutation, type PendingTaskReceipt, type TaskMutationAuditContext, type TaskMutationBeforePersist, type TaskMutationConfirmationService, type TaskMutationProposal } from "./task-mutation-confirmation.js";
import type { TaskFilter, TaskPatch, TaskReader } from "./task-store.js";

export const assistantTaskListDefaultLimit = 20;
export const assistantTaskListMaximumLimit = 50;

export type AssistantTaskView = Pick<Task, "id" | "title" | "project" | "type" | "status" | "dueDate" | "createdAt" | "updatedAt" | "revision">;

export type AssistantTaskMutationProposal =
  | { kind: "create"; title: string; project: string; type: Task["type"]; dueDate?: string }
  | { kind: "update"; taskId: string; expectedRevision: number; patch: Omit<TaskPatch, "status"> & { status?: "open" | "in_progress" } }
  | { kind: "complete"; taskId: string; expectedRevision: number }
  | { kind: "cancel"; taskId: string; expectedRevision: number };

export type AssistantIdeaToTaskProposalResult =
  | { status: "not_found" }
  | { status: "already_converted"; taskId: string }
  | { status: "needs_confirmation"; confirmation: PendingTaskReceipt };

export type AssistantTaskCapabilities = {
  list(input?: { filter?: TaskFilter; limit?: number; order?: "created_asc" | "due_asc" }): Promise<AssistantTaskView[]>;
  propose(proposal: AssistantTaskMutationProposal): Promise<PendingTaskReceipt>;
  proposeIdeaToTask(ideaId: string): Promise<AssistantIdeaToTaskProposalResult>;
};

/**
 * Request-scoped task reads and proposals. The owner and generated task id are
 * bound by the application; execution is intentionally absent from the model
 * capability surface and belongs to an authenticated owner command.
 */
export function createAssistantTaskCapabilities(input: {
  ownerId: string;
  tasks?: TaskReader;
  mutations?: Pick<TaskMutationConfirmationService, "propose">;
  ideaToTask?: Pick<IdeaToTaskService, "propose">;
  taskId: () => string;
  audit?: TaskMutationAuditContext;
  beforePersist: TaskMutationBeforePersist;
  onProposal: (pending: PendingTaskMutation) => void;
}): AssistantTaskCapabilities {
  return {
    async list(options = {}) {
      if (!input.tasks) throw new Error("task reader is not configured");
      const limit = options.limit ?? assistantTaskListDefaultLimit;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > assistantTaskListMaximumLimit) {
        throw new Error(`task list limit must be between 1 and ${assistantTaskListMaximumLimit}`);
      }
      const tasks = await input.tasks.list(input.ownerId, options.filter, { limit, order: options.order ?? "due_asc" });
      return tasks.map(toAssistantTaskView);
    },
    async propose(proposal) {
      if (!input.mutations) throw new Error("task mutation confirmation is not configured");
      const pending = await input.mutations.propose(
        input.ownerId,
        normalizeAssistantTaskProposal(proposal, input.taskId),
        { actionKind: proposal.kind, audit: input.audit, beforePersist: input.beforePersist },
      );
      input.onProposal(pending);
      return pendingTaskReceipt(pending);
    },
    async proposeIdeaToTask(ideaId) {
      if (!input.ideaToTask) throw new Error("idea to task conversion is not configured");
      const result = await input.ideaToTask.propose(input.ownerId, ideaId, input.audit, input.beforePersist);
      if (result.status === "not_found") return { status: "not_found" };
      if (result.status === "already_converted") return { status: "already_converted", taskId: result.taskId };
      input.onProposal(result.confirmation);
      return { status: "needs_confirmation", confirmation: pendingTaskReceipt(result.confirmation) };
    },
  };
}

export function toAssistantTaskView(task: Task): AssistantTaskView {
  return {
    id: task.id,
    title: task.title,
    project: task.project,
    type: task.type,
    status: task.status,
    ...(task.dueDate === undefined ? {} : { dueDate: task.dueDate }),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    revision: task.revision,
  };
}

function normalizeAssistantTaskProposal(proposal: AssistantTaskMutationProposal, taskId: () => string): TaskMutationProposal {
  switch (proposal.kind) {
    case "create":
      return {
        kind: "create",
        input: {
          id: taskId(),
          title: proposal.title,
          project: proposal.project,
          type: proposal.type,
          status: "open",
          ...(proposal.dueDate === undefined ? {} : { dueDate: proposal.dueDate }),
        },
      };
    case "update":
      return { kind: "update", taskId: proposal.taskId, expectedRevision: proposal.expectedRevision, patch: { ...proposal.patch } };
    case "complete":
      return { kind: "update", taskId: proposal.taskId, expectedRevision: proposal.expectedRevision, patch: { status: "done" } };
    case "cancel":
      return { kind: "cancel", taskId: proposal.taskId, expectedRevision: proposal.expectedRevision };
  }
}
