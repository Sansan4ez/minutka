import type { Task } from "../domain/task.js";
import type { IdeaToTaskProposalResult, IdeaToTaskService } from "./idea-to-task.js";
import type { PendingTaskMutation, TaskMutationConfirmationResult, TaskMutationConfirmationService, TaskMutationProposal } from "./task-mutation-confirmation.js";
import type { TaskFilter, TaskPatch, TaskReader } from "./task-store.js";

export const assistantTaskListDefaultLimit = 20;
export const assistantTaskListMaximumLimit = 50;

export type AssistantTaskMutationProposal =
  | { kind: "create"; title: string; project: string; type: Task["type"]; dueDate?: string }
  | { kind: "update"; taskId: string; expectedRevision: number; patch: Omit<TaskPatch, "status"> & { status?: "open" | "in_progress" } }
  | { kind: "complete"; taskId: string; expectedRevision: number }
  | { kind: "cancel"; taskId: string; expectedRevision: number };

export type AssistantTaskCapabilities = {
  list(input?: { filter?: TaskFilter; limit?: number; order?: "created_asc" | "due_asc" }): Promise<Task[]>;
  propose(proposal: AssistantTaskMutationProposal): Promise<PendingTaskMutation>;
  proposeIdeaToTask(ideaId: string): Promise<IdeaToTaskProposalResult>;
  confirm(confirmationId: string, proposal: TaskMutationProposal): Promise<TaskMutationConfirmationResult>;
};

/**
 * Request-scoped task use-cases. The owner and generated task id are bound by
 * the application; neither can be supplied by model/tool input. Idea
 * provenance can only enter through the owner-scoped idea-to-task use-case.
 */
export function createAssistantTaskCapabilities(input: {
  ownerId: string;
  tasks?: TaskReader;
  mutations?: Pick<TaskMutationConfirmationService, "propose" | "confirm">;
  ideaToTask?: Pick<IdeaToTaskService, "propose">;
  taskId: () => string;
  confirm: (operation: () => Promise<TaskMutationConfirmationResult>) => Promise<TaskMutationConfirmationResult>;
}): AssistantTaskCapabilities {
  return {
    async list(options = {}) {
      if (!input.tasks) throw new Error("task reader is not configured");
      const limit = options.limit ?? assistantTaskListDefaultLimit;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > assistantTaskListMaximumLimit) {
        throw new Error(`task list limit must be between 1 and ${assistantTaskListMaximumLimit}`);
      }
      return input.tasks.list(input.ownerId, options.filter, { limit, order: options.order ?? "due_asc" });
    },
    propose(proposal) {
      if (!input.mutations) throw new Error("task mutation confirmation is not configured");
      return input.mutations.propose(input.ownerId, normalizeAssistantTaskProposal(proposal, input.taskId));
    },
    proposeIdeaToTask(ideaId) {
      if (!input.ideaToTask) throw new Error("idea to task conversion is not configured");
      return input.ideaToTask.propose(input.ownerId, ideaId);
    },
    confirm(confirmationId, proposal) {
      if (!input.mutations) throw new Error("task mutation confirmation is not configured");
      return input.confirm(() => input.mutations!.confirm(input.ownerId, confirmationId, proposal));
    },
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
