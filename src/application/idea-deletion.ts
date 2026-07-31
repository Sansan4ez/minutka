import { randomUUID } from "node:crypto";
import { z } from "zod";
import { safeConfirmationDisplayText, type PendingTaskPreviewText } from "./task-mutation-confirmation.js";
import { safeAuditMetadata, type AuditEventStore } from "./audit-event-store.js";
import { assertUserId } from "./document-store.js";
import type { Idea, IdeaMutationResult, IdeaStore } from "./idea-store.js";
import type { Clock, IdGenerator } from "./runtime-primitives.js";

export const ideaDeletionConfirmationTtlMilliseconds = 15 * 60_000;
export const ideaDeletionUndoWindowMilliseconds = 15 * 60_000;
export const ideaDeletionSearchMaximumLimit = 10;
export const ideaDeletionConfirmationPurgeBatchSize = 500;

const requiredText = z.string().refine((value) => value.trim().length > 0, "Required text");

export type IdeaDeletionProposal = {
  ideaId: string;
  expectedRevision: number;
  reason?: string;
};

export type PendingIdeaDeletion = {
  confirmationId: string;
  ownerId: string;
  proposal: IdeaDeletionProposal;
  createdAt: string;
  expiresAt: string;
};

export type PendingIdeaDeletionReceipt = {
  confirmationId: string;
  actionKind: "delete_idea";
  summary: string;
  expiresAt: string;
};

export type PendingIdeaDeletionAction = PendingIdeaDeletionReceipt & {
  preview: {
    kind: "delete_idea";
    ideaId: PendingTaskPreviewText;
    summary: PendingTaskPreviewText;
    revision: number;
  };
};

export type IdeaDeletionDecisionResult =
  | { status: "confirmed" | "already_confirmed"; outcome: IdeaMutationResult }
  | { status: "rejected" | "already_rejected" }
  | { status: "not_found" | "expired" | "invalid_payload" };

export type IdeaDeletionConfirmationRecord = PendingIdeaDeletion & {
  decision?: "confirmed" | "rejected";
  outcome?: IdeaMutationResult;
  completedAt?: string;
};

export interface IdeaDeletionConfirmationStore {
  save(record: PendingIdeaDeletion): Promise<void>;
  decide(
    input: { confirmationId: string; ownerId: string; decision: "confirm" | "reject"; decidedAt: string; undoExpiresAt: string },
  ): Promise<{ result: IdeaDeletionDecisionResult; ideaId?: string }>;
  purge(input: { pendingExpiredBefore: string; completedBefore: string; limit: number }): Promise<number>;
}

export type IdeaDeletionAuditContext = { requestId: string; threadId?: string; messageId?: string };

export class IdeaDeletionService {
  constructor(
    private readonly ideas: IdeaStore,
    private readonly confirmations: IdeaDeletionConfirmationStore,
    private readonly clock: Clock,
    private readonly options: {
      confirmationId?: () => string;
      confirmationTtlMilliseconds?: number;
      undoWindowMilliseconds?: number;
      auditEventStore?: AuditEventStore;
      idGenerator?: Pick<IdGenerator, "auditEventId">;
    } = {},
  ) {}

  async search(ownerId: string, input: { query?: string; limit?: number } = {}): Promise<Idea[]> {
    const safeOwnerId = assertUserId(ownerId);
    const limit = input.limit ?? ideaDeletionSearchMaximumLimit;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > ideaDeletionSearchMaximumLimit) throw new Error(`limit must be between 1 and ${ideaDeletionSearchMaximumLimit}`);
    const query = input.query?.trim().toLocaleLowerCase();
    const source = await this.ideas.list(safeOwnerId, undefined, { limit: 100, order: "activity_desc" });
    return source
      .filter((idea) => !query || [idea.id, idea.project, idea.summary].some((value) => value.toLocaleLowerCase().includes(query)))
      .slice(0, limit);
  }

  async propose(
    ownerId: string,
    input: IdeaDeletionProposal,
    options: { audit?: IdeaDeletionAuditContext; beforePersist?: (record: PendingIdeaDeletion) => void | Promise<void> } = {},
  ): Promise<{ status: "not_found" | "conflict" } | { status: "needs_confirmation"; confirmation: PendingIdeaDeletion; idea: Idea }> {
    const safeOwnerId = assertUserId(ownerId);
    const proposal = normalizeProposal(input);
    const idea = await this.ideas.get(safeOwnerId, proposal.ideaId);
    if (!idea) return { status: "not_found" };
    if (idea.revision !== proposal.expectedRevision) return { status: "conflict" };
    const createdAt = assertTimestamp(this.clock.now());
    const ttl = this.options.confirmationTtlMilliseconds ?? ideaDeletionConfirmationTtlMilliseconds;
    if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new Error("confirmation ttl must be a positive safe integer");
    const record: PendingIdeaDeletion = {
      confirmationId: requiredText.parse((this.options.confirmationId ?? (() => `idea-deletion-${randomUUID()}`))()),
      ownerId: safeOwnerId,
      proposal,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + ttl).toISOString(),
    };
    await options.beforePersist?.(copyPending(record));
    await this.confirmations.save(record);
    await this.auditSafely("idea_deletion_proposed", safeOwnerId, record.confirmationId, idea.id, "pending", options.audit);
    return { status: "needs_confirmation", confirmation: copyPending(record), idea: copyIdea(idea) };
  }

  confirm(ownerId: string, confirmationId: string, audit?: IdeaDeletionAuditContext): Promise<IdeaDeletionDecisionResult> {
    return this.decide(ownerId, confirmationId, "confirm", audit);
  }

  reject(ownerId: string, confirmationId: string, audit?: IdeaDeletionAuditContext): Promise<IdeaDeletionDecisionResult> {
    return this.decide(ownerId, confirmationId, "reject", audit);
  }

  async undo(ownerId: string, input: { ideaId?: string; expectedRevision?: number } = {}, audit?: IdeaDeletionAuditContext): Promise<IdeaMutationResult> {
    const safeOwnerId = assertUserId(ownerId);
    let ideaId = input.ideaId?.trim();
    let expectedRevision = input.expectedRevision;
    if (!ideaId) {
      const deleted = await this.ideas.list(safeOwnerId, undefined, { limit: 100, order: "activity_desc", includeDeleted: true });
      const candidate = deleted.find((idea) => idea.deletedAt !== undefined);
      if (!candidate) return { outcome: "not_found" };
      ideaId = candidate.id;
      expectedRevision ??= candidate.revision;
    }
    if (!ideaId) return { outcome: "not_found" };
    const result = await this.ideas.undoDelete(safeOwnerId, ideaId, {
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      restoredAt: this.clock.now(),
    });
    await this.auditSafely("idea_deletion_undone", safeOwnerId, undefined, ideaId, result.outcome, audit);
    return result;
  }

  purge(input: { completedReplayRetentionMilliseconds: number; limit?: number; now?: string }): Promise<number> {
    const retention = input.completedReplayRetentionMilliseconds;
    if (!Number.isSafeInteger(retention) || retention <= 0) throw new Error("completed replay retention must be a positive safe integer");
    const ttl = this.options.confirmationTtlMilliseconds ?? ideaDeletionConfirmationTtlMilliseconds;
    if (retention <= ttl) throw new Error("completed replay retention must exceed the confirmation TTL");
    const limit = input.limit ?? ideaDeletionConfirmationPurgeBatchSize;
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("confirmation purge limit must be a positive safe integer");
    const now = assertTimestamp(input.now ?? this.clock.now());
    return this.confirmations.purge({
      pendingExpiredBefore: now,
      completedBefore: new Date(Date.parse(now) - retention).toISOString(),
      limit,
    });
  }

  private async decide(ownerId: string, confirmationId: string, decision: "confirm" | "reject", audit?: IdeaDeletionAuditContext): Promise<IdeaDeletionDecisionResult> {
    const safeOwnerId = assertUserId(ownerId);
    const safeConfirmationId = requiredText.parse(confirmationId);
    const decidedAt = assertTimestamp(this.clock.now());
    const undoWindow = this.options.undoWindowMilliseconds ?? ideaDeletionUndoWindowMilliseconds;
    if (!Number.isSafeInteger(undoWindow) || undoWindow <= 0) throw new Error("undo window must be a positive safe integer");
    const decided = await this.confirmations.decide({
      confirmationId: safeConfirmationId,
      ownerId: safeOwnerId,
      decision,
      decidedAt,
      undoExpiresAt: new Date(Date.parse(decidedAt) + undoWindow).toISOString(),
    });
    const result = decided.result;
    if (decided.ideaId && ["confirmed", "already_confirmed", "rejected", "already_rejected"].includes(result.status)) {
      const outcome = result.status === "confirmed" || result.status === "already_confirmed" ? result.outcome.outcome : result.status;
      await this.auditSafely("idea_deletion_decided", safeOwnerId, safeConfirmationId, decided.ideaId, outcome, audit);
    }
    return result;
  }

  private async auditSafely(type: "idea_deletion_proposed" | "idea_deletion_decided" | "idea_deletion_undone", ownerId: string, confirmationId: string | undefined, ideaId: string, result: string, context?: IdeaDeletionAuditContext): Promise<void> {
    if (!this.options.auditEventStore || !this.options.idGenerator) return;
    try {
      await this.options.auditEventStore.append({
        id: this.options.idGenerator.auditEventId(),
        requestId: context?.requestId ?? `idea-deletion:${confirmationId ?? ideaId}`,
        type,
        employeeId: ownerId,
        ...(context?.threadId ? { threadId: context.threadId } : {}),
        ...(context?.messageId ? { messageId: context.messageId } : {}),
        occurredAt: this.clock.now(),
        metadata: safeAuditMetadata(type, {
          ideaId,
          recordType: "idea",
          result,
          ...(confirmationId ? { confirmationId } : {}),
        }),
      });
    } catch {
      // Audit is diagnostic and must not change deletion semantics.
    }
  }
}

export function pendingIdeaDeletionReceipt(record: PendingIdeaDeletion): PendingIdeaDeletionReceipt {
  return {
    confirmationId: record.confirmationId,
    actionKind: "delete_idea",
    summary: `Удалить идею ${record.proposal.ideaId}`,
    expiresAt: record.expiresAt,
  };
}

export function pendingIdeaDeletionAction(record: PendingIdeaDeletion, idea: Idea): PendingIdeaDeletionAction {
  return {
    ...pendingIdeaDeletionReceipt(record),
    preview: {
      kind: "delete_idea",
      ideaId: safeConfirmationDisplayText(idea.id),
      summary: safeConfirmationDisplayText(idea.summary),
      revision: idea.revision,
    },
  };
}

export function normalizeProposal(input: IdeaDeletionProposal): IdeaDeletionProposal {
  const ideaId = requiredText.parse(input.ideaId);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision <= 0) throw new Error("expectedRevision must be a positive safe integer");
  const reason = input.reason?.trim();
  return { ideaId, expectedRevision: input.expectedRevision, ...(reason ? { reason } : {}) };
}

export function copyIdeaMutationResult(result: IdeaMutationResult): IdeaMutationResult {
  switch (result.outcome) {
    case "not_found": return { outcome: "not_found" };
    case "expired": return { outcome: "expired" };
    case "conflict": return result.current ? { outcome: "conflict", current: copyIdea(result.current) } : { outcome: "conflict" };
    case "deleted": case "already_deleted": case "restored": case "unchanged":
      return { outcome: result.outcome, idea: copyIdea(result.idea) };
  }
}

function copyPending(record: PendingIdeaDeletion): PendingIdeaDeletion {
  return { ...record, proposal: { ...record.proposal } };
}

function copyIdea(idea: Idea): Idea {
  return { ...idea, ...(idea.source ? { source: { ...idea.source } } : {}) };
}

function assertTimestamp(value: string): string {
  if (!value || !Number.isFinite(Date.parse(value))) throw new Error("valid timestamp is required");
  return value;
}
