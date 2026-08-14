import { safeAuditMetadata, type AuditEventStore } from "./audit-event-store.js";
import { assertUserId } from "./document-store.js";
import type { IdeaAppendMutationResult, IdeaStore } from "./idea-store.js";
import type { Clock, IdGenerator } from "./runtime-primitives.js";
import { randomIdGenerator, systemClock } from "./runtime-primitives.js";

export type AppendIdeaInput = {
  ideaId: string;
  expectedRevision: number;
  text: string;
};

export type AppendIdeaResult = IdeaAppendMutationResult;
export type IdeaAppendAuditContext = { requestId: string; threadId?: string; messageId?: string };

/** Owner-scoped level-0 mutation used to enrich an existing idea instead of creating a duplicate. */
export class IdeaAppendService {
  private readonly clock: Clock;
  private readonly ids: Pick<IdGenerator, "auditEventId">;

  constructor(
    private readonly ideas: Pick<IdeaStore, "append" | "get">,
    private readonly options: {
      auditEventStore?: AuditEventStore;
      clock?: Clock;
      idGenerator?: Pick<IdGenerator, "auditEventId">;
    } = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.ids = options.idGenerator ?? randomIdGenerator;
  }

  async append(ownerId: string, input: AppendIdeaInput, audit?: IdeaAppendAuditContext): Promise<AppendIdeaResult> {
    const safeOwnerId = assertUserId(ownerId);
    const ideaId = input.ideaId.trim();
    if (!ideaId) throw new Error("ideaId is required");
    const text = input.text.trim();
    if (!text) throw new Error("append text is required");
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision <= 0) {
      throw new Error("expectedRevision must be a positive safe integer");
    }
    let result: AppendIdeaResult;
    try {
      result = await this.ideas.append(safeOwnerId, ideaId, {
        expectedRevision: input.expectedRevision,
        text,
      });
    } catch (cause) {
      if (await this.ideas.get(safeOwnerId, ideaId)) throw cause;
      return { status: "not_found" };
    }
    if (result.status === "applied") await this.auditSafely(safeOwnerId, result.idea.id, result.idea.type, audit);
    return result;
  }

  private async auditSafely(ownerId: string, ideaId: string, recordType: string, context?: IdeaAppendAuditContext): Promise<void> {
    if (!this.options.auditEventStore) return;
    try {
      await this.options.auditEventStore.append({
        id: this.ids.auditEventId(),
        requestId: context?.requestId ?? `idea-append:${ideaId}`,
        type: "idea_appended",
        employeeId: ownerId,
        ...(context?.threadId ? { threadId: context.threadId } : {}),
        ...(context?.messageId ? { messageId: context.messageId } : {}),
        occurredAt: this.clock.now(),
        metadata: safeAuditMetadata("idea_appended", { ideaId, recordType }),
      });
    } catch (error) {
      logIdeaAppendOperationalError(error);
    }
  }
}

function logIdeaAppendOperationalError(error: unknown): void {
  console.warn(`Assistant idea append audit failed (${error instanceof Error ? error.name : "UnknownError"}).`);
}
