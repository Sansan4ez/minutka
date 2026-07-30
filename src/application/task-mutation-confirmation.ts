import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Task } from "../domain/task.js";
import { pendingTaskSummaryMaximumCodePoints } from "../shared/chat-limits.js";
import { safeAuditMetadata, type AuditEventStore } from "./audit-event-store.js";
import type { Clock, IdGenerator } from "./runtime-primitives.js";
import { normalizeTaskPatch } from "./task-store.js";
import type { CreateTaskInput, TaskMutationResult, TaskPatch, TaskWriter } from "./task-store.js";

export const taskMutationConfirmationTtlMilliseconds = 15 * 60_000;
export const taskMutationConfirmationPurgeBatchSize = 500;

const recordTypeSchema = z.enum(["money", "development", "content", "people", "operations", "knowledge", "personal"]);
const taskStatusSchema = z.enum(["open", "in_progress", "done", "cancelled"]);
const dueDateSchema = z.string().refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)
  && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value, "Invalid due date");
const requiredText = z.string().refine((value) => value.trim().length > 0, "Required text");
const taskPatchSchema = z.strictObject({
  title: requiredText.optional(),
  project: requiredText.optional(),
  type: recordTypeSchema.optional(),
  status: taskStatusSchema.optional(),
  dueDate: dueDateSchema.nullable().optional(),
});
const proposalSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("create"),
    input: z.strictObject({
      id: requiredText,
      title: requiredText,
      project: requiredText,
      type: recordTypeSchema,
      status: taskStatusSchema,
      dueDate: dueDateSchema.optional(),
      originIdeaId: requiredText.optional(),
    }),
  }),
  z.strictObject({ kind: z.literal("update"), taskId: requiredText, expectedRevision: z.number().int().positive(), patch: taskPatchSchema }),
  z.strictObject({ kind: z.literal("cancel"), taskId: requiredText, expectedRevision: z.number().int().positive() }),
]);

export type TaskMutationProposal =
  | { kind: "create"; input: CreateTaskInput }
  | { kind: "update"; taskId: string; expectedRevision: number; patch: TaskPatch }
  | { kind: "cancel"; taskId: string; expectedRevision: number };

export type TaskPendingActionKind = "create" | "update" | "complete" | "cancel" | "idea_to_task";
export const pendingTaskPreviewValueMaximumCharacters = 280;

const unsafeConfirmationDisplayCodePoint = /[\p{Cc}\p{Cf}]/u;

/** Canonical private record. It must never cross a transport or model boundary. */
export type PendingTaskMutation = {
  confirmationId: string;
  ownerId: string;
  actionKind: TaskPendingActionKind;
  proposal: TaskMutationProposal;
  payloadDigest: string;
  createdAt: string;
  expiresAt: string;
};

export type PendingTaskReceipt = {
  confirmationId: string;
  actionKind: TaskPendingActionKind;
  summary: string;
  expiresAt: string;
};

export type PendingTaskPreviewText = { value: string; truncated: boolean };
export type PendingTaskUpdatePreviewField =
  | { field: "title" | "project"; value: PendingTaskPreviewText }
  | { field: "type"; value: Task["type"] }
  | { field: "status"; value: Task["status"] }
  | { field: "dueDate"; value: string | null };
export type PendingTaskActionPreview =
  | { kind: "create" | "idea_to_task"; title: PendingTaskPreviewText; project: PendingTaskPreviewText; type: Task["type"]; dueDate: string | null }
  | { kind: "update"; taskId: PendingTaskPreviewText; fields: PendingTaskUpdatePreviewField[] }
  | { kind: "complete" | "cancel"; taskId: PendingTaskPreviewText };

/** Owner-visible transport projection. Canonical proposal authority remains private. */
export type PendingTaskAction = PendingTaskReceipt & { preview: PendingTaskActionPreview };

export type TaskMutationDecisionResult =
  | { status: "confirmed" | "already_confirmed"; outcome: TaskMutationResult }
  | { status: "rejected" | "already_rejected" }
  | { status: "not_found" | "owner_mismatch" | "expired" | "invalid_payload" };

export type TaskMutationConfirmationRecord = PendingTaskMutation & {
  decision?: "confirmed" | "rejected";
  outcome?: TaskMutationResult;
  completedAt?: string;
};

/**
 * Persistence boundary that row-locks one canonical proposal and applies its
 * task write in the same atomic scope. The caller supplies only owner, opaque
 * id, decision and time; payload authority stays server-side.
 */
export interface TaskMutationConfirmationStore {
  save(record: PendingTaskMutation): Promise<void>;
  decide(
    input: { confirmationId: string; ownerId: string; decision: "confirm" | "reject"; decidedAt: string },
    effect: (writer: TaskWriter, proposal: TaskMutationProposal) => Promise<TaskMutationResult>,
  ): Promise<{ result: TaskMutationDecisionResult; actionKind?: TaskPendingActionKind; taskId?: string }>;
  purge(input: { pendingExpiredBefore: string; completedBefore: string; limit: number }): Promise<number>;
}

export type TaskMutationAuditContext = { requestId: string; threadId?: string; messageId?: string };
/** Private pre-save observation point for request-scoped reservation and recovery. */
export type TaskMutationBeforePersist = (record: PendingTaskMutation) => void | Promise<void>;

export class TaskMutationConfirmationService {
  constructor(
    private readonly store: TaskMutationConfirmationStore,
    private readonly clock: Clock,
    private readonly options: {
      ttlMilliseconds?: number;
      confirmationId?: () => string;
      auditEventStore?: AuditEventStore;
      idGenerator?: Pick<IdGenerator, "auditEventId">;
    } = {},
  ) {}

  async propose(
    ownerId: string,
    proposal: TaskMutationProposal,
    options: { actionKind?: TaskPendingActionKind; audit?: TaskMutationAuditContext; beforePersist?: TaskMutationBeforePersist } = {},
  ): Promise<PendingTaskMutation> {
    const safeOwnerId = assertOwnerId(ownerId);
    const normalized = normalizeTaskMutationProposal(proposal);
    const actionKind = options.actionKind ?? inferTaskPendingActionKind(normalized);
    if (!taskActionKindMatchesProposal(actionKind, normalized)) throw new Error("task action kind does not match proposal");
    const createdAt = assertTimestamp(this.clock.now());
    const ttl = this.options.ttlMilliseconds ?? taskMutationConfirmationTtlMilliseconds;
    if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new Error("confirmation ttl must be a positive safe integer");
    const record: PendingTaskMutation = {
      confirmationId: requiredText.parse((this.options.confirmationId ?? (() => `task-confirmation-${randomUUID()}`))()),
      ownerId: safeOwnerId,
      actionKind,
      proposal: normalized,
      payloadDigest: taskMutationPayloadDigest(normalized),
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + ttl).toISOString(),
    };
    await options.beforePersist?.(copyPending(record));
    await this.store.save(record);
    await this.auditSafely("task_mutation_proposed", safeOwnerId, record.confirmationId, actionKind, "pending", options.audit, undefined, taskMutationProposalTaskId(normalized));
    return copyPending(record);
  }

  confirm(ownerId: string, confirmationId: string, audit?: TaskMutationAuditContext): Promise<TaskMutationDecisionResult> {
    return this.decide(ownerId, confirmationId, "confirm", audit);
  }

  reject(ownerId: string, confirmationId: string, audit?: TaskMutationAuditContext): Promise<TaskMutationDecisionResult> {
    return this.decide(ownerId, confirmationId, "reject", audit);
  }

  purge(input: { completedReplayRetentionMilliseconds: number; limit?: number; now?: string }): Promise<number> {
    const retention = input.completedReplayRetentionMilliseconds;
    if (!Number.isSafeInteger(retention) || retention <= 0) throw new Error("completed replay retention must be a positive safe integer");
    const ttl = this.options.ttlMilliseconds ?? taskMutationConfirmationTtlMilliseconds;
    if (retention <= ttl) throw new Error("completed replay retention must exceed the confirmation TTL");
    const limit = input.limit ?? taskMutationConfirmationPurgeBatchSize;
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error("confirmation purge limit must be a positive safe integer");
    const now = assertTimestamp(input.now ?? this.clock.now());
    return this.store.purge({
      pendingExpiredBefore: now,
      completedBefore: new Date(Date.parse(now) - retention).toISOString(),
      limit,
    });
  }

  private async decide(ownerId: string, confirmationId: string, decision: "confirm" | "reject", audit?: TaskMutationAuditContext): Promise<TaskMutationDecisionResult> {
    const safeOwnerId = assertOwnerId(ownerId);
    const safeConfirmationId = requiredText.parse(confirmationId);
    const decidedAt = assertTimestamp(this.clock.now());
    const decided = await this.store.decide({
      confirmationId: safeConfirmationId,
      ownerId: safeOwnerId,
      decision,
      decidedAt,
    }, (writer, proposal) => executeTaskMutation(writer, safeOwnerId, proposal));
    const result = decided.result;
    if (terminalAuditStatus(result.status) && decided.actionKind) {
      await this.auditSafely(
        "task_mutation_decided",
        safeOwnerId,
        safeConfirmationId,
        decided.actionKind,
        result.status,
        audit,
        result.status === "confirmed" || result.status === "already_confirmed" ? result.outcome : undefined,
        decided.taskId,
      );
    }
    return result;
  }

  private async auditSafely(
    type: "task_mutation_proposed" | "task_mutation_decided",
    ownerId: string,
    confirmationId: string,
    actionKind: TaskPendingActionKind,
    status: string,
    context?: TaskMutationAuditContext,
    outcome?: TaskMutationResult,
    proposedTaskId?: string,
  ): Promise<void> {
    if (!this.options.auditEventStore || !this.options.idGenerator) return;
    try {
      const taskId = taskIdFromOutcome(outcome) ?? proposedTaskId;
      await this.options.auditEventStore.append({
        id: this.options.idGenerator.auditEventId(),
        requestId: context?.requestId ?? `task-mutation:${confirmationId}`,
        type,
        employeeId: ownerId,
        ...(context?.threadId ? { threadId: context.threadId } : {}),
        ...(context?.messageId ? { messageId: context.messageId } : {}),
        occurredAt: this.clock.now(),
        metadata: safeAuditMetadata(type, {
          confirmationId,
          actionKind,
          status,
          ...(outcome ? { result: outcome.outcome } : {}),
          ...(taskId ? { taskId } : {}),
        }),
      });
    } catch {
      // Audit is diagnostic and must not change task proposal/decision semantics.
    }
  }
}

export function pendingTaskReceipt(record: PendingTaskMutation): PendingTaskReceipt {
  return {
    confirmationId: record.confirmationId,
    actionKind: record.actionKind,
    summary: boundedSummary(taskActionSummary(record.actionKind, record.proposal), pendingTaskSummaryMaximumCodePoints),
    expiresAt: record.expiresAt,
  };
}

export function pendingTaskAction(record: PendingTaskMutation): PendingTaskAction {
  return { ...pendingTaskReceipt(record), preview: pendingTaskActionPreview(record.actionKind, record.proposal) };
}

export function normalizeTaskMutationProposal(proposal: TaskMutationProposal): TaskMutationProposal {
  const parsed = proposalSchema.parse(proposal);
  if (parsed.kind === "create") return { kind: "create", input: { ...parsed.input } };
  if (parsed.kind === "cancel") return { kind: "cancel", taskId: parsed.taskId, expectedRevision: parsed.expectedRevision };
  return { kind: "update", taskId: parsed.taskId, expectedRevision: parsed.expectedRevision, patch: normalizeTaskPatch(parsed.patch) };
}

export function taskMutationPayloadDigest(proposal: TaskMutationProposal): string {
  return createHash("sha256").update(stableJson(normalizeTaskMutationProposal(proposal))).digest("hex");
}

export function taskActionKindMatchesProposal(actionKind: TaskPendingActionKind, proposal: TaskMutationProposal): boolean {
  switch (actionKind) {
    case "create": return proposal.kind === "create";
    case "idea_to_task": return proposal.kind === "create" && proposal.input.originIdeaId !== undefined;
    case "cancel": return proposal.kind === "cancel";
    case "complete": return proposal.kind === "update" && Object.keys(proposal.patch).length === 1 && proposal.patch.status === "done";
    case "update": return proposal.kind === "update";
  }
}

export async function executeTaskMutation(writer: TaskWriter, ownerId: string, proposal: TaskMutationProposal): Promise<TaskMutationResult> {
  switch (proposal.kind) {
    case "create": return writer.create(ownerId, proposal.input);
    case "update": return writer.update(ownerId, proposal.taskId, { expectedRevision: proposal.expectedRevision, patch: proposal.patch });
    case "cancel": return writer.update(ownerId, proposal.taskId, { expectedRevision: proposal.expectedRevision, patch: { status: "cancelled" } });
  }
}

export function taskMutationProposalTaskId(proposal: TaskMutationProposal): string {
  return proposal.kind === "create" ? proposal.input.id : proposal.taskId;
}

export function copyTaskMutationResult(result: TaskMutationResult): TaskMutationResult {
  if (result.outcome === "not_found") return { outcome: "not_found" };
  if (result.outcome === "conflict") return result.current ? { outcome: "conflict", current: copyTask(result.current) } : { outcome: "conflict" };
  return { outcome: result.outcome, task: copyTask(result.task) };
}

function terminalAuditStatus(status: TaskMutationDecisionResult["status"]): boolean {
  return status === "confirmed" || status === "already_confirmed" || status === "rejected" || status === "already_rejected";
}

function taskIdFromOutcome(outcome: TaskMutationResult | undefined): string | undefined {
  if (!outcome || outcome.outcome === "not_found") return undefined;
  return outcome.outcome === "conflict" ? outcome.current?.id : outcome.task.id;
}

function inferTaskPendingActionKind(proposal: TaskMutationProposal): TaskPendingActionKind {
  if (proposal.kind === "create") return proposal.input.originIdeaId === undefined ? "create" : "idea_to_task";
  if (proposal.kind === "cancel") return "cancel";
  return Object.keys(proposal.patch).length === 1 && proposal.patch.status === "done" ? "complete" : "update";
}

function pendingTaskActionPreview(actionKind: TaskPendingActionKind, proposal: TaskMutationProposal): PendingTaskActionPreview {
  if (proposal.kind === "create") {
    return {
      kind: actionKind === "idea_to_task" ? "idea_to_task" : "create",
      title: previewText(proposal.input.title),
      project: previewText(proposal.input.project),
      type: proposal.input.type,
      dueDate: proposal.input.dueDate ?? null,
    };
  }
  if (actionKind === "complete") return { kind: "complete", taskId: previewText(proposal.taskId) };
  if (actionKind === "cancel") return { kind: "cancel", taskId: previewText(proposal.taskId) };
  if (proposal.kind !== "update") throw new Error("task action kind does not match proposal");
  const fields: PendingTaskUpdatePreviewField[] = [];
  for (const field of ["title", "project", "type", "status", "dueDate"] as const) {
    if (!Object.prototype.hasOwnProperty.call(proposal.patch, field)) continue;
    const value = proposal.patch[field];
    if (field === "title" || field === "project") fields.push({ field, value: previewText(value as string) });
    else if (field === "dueDate") fields.push({ field, value: value as string | null });
    else if (field === "type") fields.push({ field, value: value as Task["type"] });
    else fields.push({ field, value: value as Task["status"] });
  }
  return { kind: "update", taskId: previewText(proposal.taskId), fields };
}

export function safeConfirmationDisplayText(value: string): PendingTaskPreviewText {
  const escaped = [...value.replace(/[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu, " ").replace(/^ +| +$/gu, "")]
    .map((character) => unsafeConfirmationDisplayCodePoint.test(character) ? unicodeDisplayToken(character) : character)
    .join("");
  const characters = [...escaped];
  return {
    value: characters.slice(0, pendingTaskPreviewValueMaximumCharacters).join(""),
    truncated: characters.length > pendingTaskPreviewValueMaximumCharacters,
  };
}

function previewText(value: string): PendingTaskPreviewText {
  return safeConfirmationDisplayText(value);
}

function unicodeDisplayToken(character: string): string {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) throw new Error("confirmation display character is required");
  return `<U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}>`;
}

function taskActionSummary(actionKind: TaskPendingActionKind, proposal: TaskMutationProposal): string {
  if (proposal.kind === "create") {
    return actionKind === "idea_to_task"
      ? `Создать задачу из идеи: ${proposal.input.title}`
      : `Создать задачу: ${proposal.input.title}`;
  }
  if (actionKind === "complete") return `Завершить задачу ${proposal.taskId}`;
  if (actionKind === "cancel") return `Отменить задачу ${proposal.taskId}`;
  return `Изменить задачу ${proposal.taskId}`;
}

function boundedSummary(value: string, maximumCharacters: number): string {
  const characters = [...value.trim().replace(/\s+/g, " ")];
  return characters.length <= maximumCharacters ? characters.join("") : `${characters.slice(0, maximumCharacters - 1).join("")}…`;
}

function copyPending(record: PendingTaskMutation): PendingTaskMutation {
  return { ...record, proposal: normalizeTaskMutationProposal(record.proposal) };
}

function copyTask(task: Task): Task { return { ...task }; }
function assertOwnerId(value: string): string { return requiredText.parse(value); }
function assertTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) throw new Error("clock must return an ISO timestamp");
  return value;
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
