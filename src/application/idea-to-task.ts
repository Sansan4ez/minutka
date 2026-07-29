import { createHash } from "node:crypto";
import type { Task } from "../domain/task.js";
import type { IdeaStore } from "./idea-store.js";
import type { TaskReader } from "./task-store.js";
import type {
  PendingTaskMutation,
  TaskMutationAuditContext,
  TaskMutationBeforePersist,
  TaskMutationConfirmationService,
} from "./task-mutation-confirmation.js";

export type IdeaToTaskProposalResult =
  | { status: "not_found" }
  | { status: "already_converted"; taskId: string; originIdeaId: string }
  | { status: "needs_confirmation"; confirmation: PendingTaskMutation; taskId: string; originIdeaId: string };

/** Owner-bound application use-case for preserving idea provenance in a confirmed task creation. */
export class IdeaToTaskService {
  constructor(
    private readonly ideas: Pick<IdeaStore, "get">,
    private readonly tasks: Pick<TaskReader, "getByOriginIdeaId">,
    private readonly confirmations: Pick<TaskMutationConfirmationService, "propose">,
  ) {}

  async propose(ownerId: string, ideaId: string, audit?: TaskMutationAuditContext, beforePersist?: TaskMutationBeforePersist): Promise<IdeaToTaskProposalResult> {
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
    }, { actionKind: "idea_to_task", audit, beforePersist });
    return { status: "needs_confirmation", confirmation, taskId, originIdeaId: idea.id };
  }
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
