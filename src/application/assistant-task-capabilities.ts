import type { Task } from "../domain/task.js";
import type { IdeaToTaskService } from "./idea-to-task.js";
import { pendingTaskReceipt, type PendingTaskMutation, type PendingTaskReceipt, type TaskMutationAuditContext, type TaskMutationBeforePersist, type TaskMutationConfirmationService, type TaskMutationDecisionResult, type TaskMutationProposal, type TaskMutationUndoResult } from "./task-mutation-confirmation.js";
import type { TaskFilter, TaskPatch, TaskReader } from "./task-store.js";

export const assistantTaskListDefaultLimit = 20;
export const assistantTaskListMaximumLimit = 50;

export type AssistantTaskView = Pick<Task, "id" | "title" | "project" | "type" | "status" | "dueDate" | "createdAt" | "updatedAt" | "revision">;

export type AssistantTaskMutationProposal =
  | { kind: "create"; title: string; project: string; type: Task["type"]; dueDate?: string }
  | { kind: "update"; taskId: string; expectedRevision?: number; patch: Omit<TaskPatch, "status"> & { status?: "open" | "in_progress" } }
  | { kind: "complete"; taskId: string; expectedRevision?: number }
  | { kind: "cancel"; taskId: string; expectedRevision?: number };

export type AppliedTaskMutation = {
  status: "applied";
  actionKind: "create" | "update" | "complete" | "idea_to_task";
  task: AssistantTaskView;
  undoAvailable: true;
};

export type TerminalTaskMutationNoEffect =
  | { status: "conflict"; actionKind: AppliedTaskMutation["actionKind"]; current?: AssistantTaskView }
  | { status: "not_found"; actionKind: AppliedTaskMutation["actionKind"] };

export type ResolvedTaskMutation = AppliedTaskMutation | TerminalTaskMutationNoEffect;
export type AssistantTaskMutationResult = ResolvedTaskMutation | PendingTaskReceipt;
export type AssistantTaskUndoResult =
  | {
      status: "undone" | "already_undone";
      actionKind: AppliedTaskMutation["actionKind"];
      task: AssistantTaskView;
      ideaStatusRestored?: boolean;
      ideaStatusConflict?: boolean;
    }
  | { status: "not_found" | "expired" }
  | { status: "conflict"; actionKind: AppliedTaskMutation["actionKind"]; current?: AssistantTaskView };
export type AssistantIdeaToTaskProposalResult =
  | { status: "not_found" }
  | { status: "already_converted"; taskId: string }
  | ResolvedTaskMutation;

export type AssistantTaskCapabilityCallbacks = {
  beforePersist: TaskMutationBeforePersist;
  onProposal: (pending: PendingTaskMutation, taskTitle?: string) => void;
  onResolved: (result: ResolvedTaskMutation, pending: PendingTaskMutation) => void;
};

export type AssistantTaskCapabilities = {
  list(input?: { filter?: TaskFilter; limit?: number; order?: "created_asc" | "due_asc" }): Promise<AssistantTaskView[]>;
  propose(proposal: AssistantTaskMutationProposal): Promise<AssistantTaskMutationResult>;
  proposeIdeaToTask(ideaId: string): Promise<AssistantIdeaToTaskProposalResult>;
  undoLast(): Promise<AssistantTaskUndoResult>;
};

/**
 * Request-scoped task reads and proposals. The owner and generated task id are
 * bound by the application; execution is intentionally absent from the model
 * capability surface and belongs to an authenticated owner command.
 */
export function createAssistantTaskCapabilities(input: {
  ownerId: string;
  tasks?: TaskReader;
  mutations?: Pick<TaskMutationConfirmationService, "propose"> & Partial<Pick<TaskMutationConfirmationService, "autoApply" | "undo">>;
  ideaToTask?: Pick<IdeaToTaskService, "propose">;
  taskId: () => string;
  canonicalizeProject?: (project: string) => Promise<string>;
  audit?: TaskMutationAuditContext;
  beforePersist: AssistantTaskCapabilityCallbacks["beforePersist"];
  onProposal: AssistantTaskCapabilityCallbacks["onProposal"];
  onResolved: AssistantTaskCapabilityCallbacks["onResolved"];
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
      const normalized = await normalizeAssistantTaskProposal(proposal, input.taskId, input.ownerId, input.tasks, input.canonicalizeProject);
      const taskTitle = proposal.kind === "create" ? undefined : await resolveTaskTitle(input.ownerId, proposal.taskId, input.tasks);
      const pending = await input.mutations.propose(
        input.ownerId,
        normalized,
        { actionKind: proposal.kind, audit: input.audit, beforePersist: input.beforePersist },
      );
      input.onProposal(pending, taskTitle);
      if (proposal.kind === "cancel" || !input.mutations.autoApply) return pendingTaskReceipt(pending);
      const resolved = resolvedTaskMutation(proposal.kind, await input.mutations.autoApply(input.ownerId, pending.confirmationId, input.audit));
      input.onResolved(resolved, pending);
      return resolved;
    },
    async proposeIdeaToTask(ideaId) {
      if (!input.ideaToTask) throw new Error("idea to task conversion is not configured");
      const result = await input.ideaToTask.propose(input.ownerId, ideaId, input.audit, input.beforePersist);
      if (result.status === "not_found") return { status: "not_found" };
      if (result.status === "already_converted") return { status: "already_converted", taskId: result.taskId };
      input.onProposal(result.confirmation);
      if (!input.mutations?.autoApply) return { status: "needs_confirmation", confirmation: pendingTaskReceipt(result.confirmation) } as never;
      const resolved = resolvedTaskMutation("idea_to_task", await input.mutations.autoApply(input.ownerId, result.confirmation.confirmationId, input.audit));
      input.onResolved(resolved, result.confirmation);
      return resolved;
    },
    async undoLast() {
      if (!input.mutations?.undo) throw new Error("task mutation undo is not configured");
      return toAssistantTaskUndoResult(await input.mutations.undo(input.ownerId, input.audit));
    },
  };
}

function toAssistantTaskUndoResult(result: TaskMutationUndoResult): AssistantTaskUndoResult {
  if (result.status === "not_found") return { status: "not_found" };
  if (result.status === "expired") return { status: "expired" };
  if (result.status === "conflict") return { status: "conflict", actionKind: result.actionKind, ...(result.current ? { current: toAssistantTaskView(result.current) } : {}) };
  const completed = result as Extract<TaskMutationUndoResult, { status: "undone" | "already_undone" }>;
  return {
    status: completed.status,
    actionKind: completed.actionKind,
    task: toAssistantTaskView(completed.task),
    ...(completed.ideaStatusRestored === undefined ? {} : { ideaStatusRestored: completed.ideaStatusRestored }),
    ...(completed.ideaStatusConflict === undefined ? {} : { ideaStatusConflict: completed.ideaStatusConflict }),
  };
}

function resolvedTaskMutation(actionKind: AppliedTaskMutation["actionKind"], decision: TaskMutationDecisionResult): ResolvedTaskMutation {
  if (decision.status !== "confirmed" && decision.status !== "already_confirmed") throw new Error(`task mutation auto-apply failed: ${decision.status}`);
  if (decision.outcome.outcome === "not_found") return { status: "not_found", actionKind };
  if (decision.outcome.outcome === "conflict") {
    return {
      status: "conflict",
      actionKind,
      ...(decision.outcome.current ? { current: toAssistantTaskView(decision.outcome.current) } : {}),
    };
  }
  return { status: "applied", actionKind, task: toAssistantTaskView(decision.outcome.task), undoAvailable: true };
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

async function normalizeAssistantTaskProposal(
  proposal: AssistantTaskMutationProposal,
  taskId: () => string,
  ownerId: string,
  tasks?: TaskReader,
  canonicalizeProject?: (project: string) => Promise<string>,
): Promise<TaskMutationProposal> {
  switch (proposal.kind) {
    case "create":
      return {
        kind: "create",
        input: {
          id: taskId(),
          title: proposal.title,
          project: canonicalizeProject ? await canonicalizeProject(proposal.project) : proposal.project,
          type: proposal.type,
          status: "open",
          ...(proposal.dueDate === undefined ? {} : { dueDate: proposal.dueDate }),
        },
      };
    case "update":
      return {
        kind: "update",
        taskId: proposal.taskId,
        expectedRevision: await resolveExpectedRevision(proposal, ownerId, tasks),
        patch: {
          ...proposal.patch,
          ...(proposal.patch.project === undefined
            ? {}
            : { project: canonicalizeProject ? await canonicalizeProject(proposal.patch.project) : proposal.patch.project }),
        },
      };
    case "complete":
      return { kind: "update", taskId: proposal.taskId, expectedRevision: await resolveExpectedRevision(proposal, ownerId, tasks), patch: { status: "done" } };
    case "cancel":
      return { kind: "cancel", taskId: proposal.taskId, expectedRevision: await resolveExpectedRevision(proposal, ownerId, tasks) };
  }
}

async function resolveExpectedRevision(
  proposal: Exclude<AssistantTaskMutationProposal, { kind: "create" }>,
  ownerId: string,
  tasks?: TaskReader,
): Promise<number> {
  if (proposal.expectedRevision !== undefined) return proposal.expectedRevision;
  const task = await getTask(ownerId, proposal.taskId, tasks);
  return task.revision;
}

async function resolveTaskTitle(ownerId: string, taskId: string, tasks?: TaskReader): Promise<string> {
  return (await getTask(ownerId, taskId, tasks)).title;
}

async function getTask(ownerId: string, taskId: string, tasks?: TaskReader): Promise<Task> {
  if (!tasks) throw new Error("task reader is not configured");
  const task = await tasks.get(ownerId, taskId);
  if (!task) throw new Error("task not found");
  return task;
}
