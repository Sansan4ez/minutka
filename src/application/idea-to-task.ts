import { createHash } from "node:crypto";
import type { Task } from "../domain/task.js";
import type { IdeaStore } from "./idea-store.js";
import type { TaskReader } from "./task-store.js";
import type {
  PendingTaskMutation,
  TaskMutationConfirmationResult,
  TaskMutationConfirmationService,
} from "./task-mutation-confirmation.js";

export type IdeaToTaskProposalResult =
  | { status: "not_found" }
  | { status: "already_converted"; taskId: string; originIdeaId: string }
  | { status: "needs_confirmation"; confirmation: PendingTaskMutation; taskId: string; originIdeaId: string };

export type IdeaToTaskConfirmationResult =
  | { status: "confirmed" | "already_confirmed"; outcome: "created" | "unchanged"; taskId: string; originIdeaId: string }
  | { status: "not_found" | "owner_mismatch" | "expired" | "payload_mismatch" | "conflict" };

/** Owner-bound application use-case for preserving idea provenance in a confirmed task creation. */
export class IdeaToTaskService {
  constructor(
    private readonly ideas: Pick<IdeaStore, "get">,
    private readonly tasks: Pick<TaskReader, "getByOriginIdeaId">,
    private readonly confirmations: Pick<TaskMutationConfirmationService, "propose" | "confirm">,
  ) {}

  async propose(ownerId: string, ideaId: string): Promise<IdeaToTaskProposalResult> {
    const safeOwnerId = requiredText(ownerId, "ownerId");
    const safeIdeaId = requiredText(ideaId, "ideaId");
    const idea = await this.ideas.get(safeOwnerId, safeIdeaId);
    if (!idea) return { status: "not_found" };

    const existing = await this.tasks.getByOriginIdeaId(safeOwnerId, safeIdeaId);
    if (existing) return converted(existing);

    const taskId = ideaTaskId(safeOwnerId, safeIdeaId);
    const confirmation = await this.confirmations.propose(safeOwnerId, {
      kind: "create",
      input: {
        id: taskId,
        title: idea.summary,
        project: idea.project,
        type: idea.type,
        status: "open",
        originIdeaId: idea.id,
      },
    });
    return { status: "needs_confirmation", confirmation, taskId, originIdeaId: idea.id };
  }

  async confirm(ownerId: string, confirmationId: string, confirmation: PendingTaskMutation): Promise<IdeaToTaskConfirmationResult> {
    const safeOwnerId = requiredText(ownerId, "ownerId");
    if (confirmation.proposal.kind !== "create" || confirmation.proposal.input.originIdeaId === undefined) return { status: "payload_mismatch" };
    const result = await this.confirmations.confirm(safeOwnerId, confirmationId, confirmation.proposal);
    return mapConfirmation(result, confirmation.proposal.input.originIdeaId);
  }
}

function mapConfirmation(result: TaskMutationConfirmationResult, originIdeaId: string): IdeaToTaskConfirmationResult {
  if (!("outcome" in result)) return { status: result.status };
  if (result.outcome.outcome === "created" || result.outcome.outcome === "unchanged") {
    if (result.outcome.task.originIdeaId !== originIdeaId) return { status: "conflict" };
    return { status: result.status, outcome: result.outcome.outcome, taskId: result.outcome.task.id, originIdeaId };
  }
  return { status: result.outcome.outcome === "conflict" ? "conflict" : "not_found" };
}

function converted(task: Task): IdeaToTaskProposalResult {
  return { status: "already_converted", taskId: task.id, originIdeaId: task.originIdeaId! };
}

function ideaTaskId(ownerId: string, ideaId: string): string {
  const digest = createHash("sha256").update(`${ownerId}\u0000${ideaId}`).digest("hex").slice(0, 32);
  return `task_idea_${digest}`;
}

function requiredText(value: string, field: string): string {
  if (!value.trim()) throw new Error(`${field} is required`);
  return value;
}
