import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Task } from "../domain/task.js";
import type { Clock } from "./runtime-primitives.js";
import type { CreateTaskInput, TaskMutationResult, TaskPatch, TaskWriter } from "./task-store.js";

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
}).refine((patch) => Object.keys(patch).length > 0, "Task patch must not be empty");
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

/** Privacy-safe projection returned by chat and confirmation UIs. */
export type PendingTaskAction = {
  confirmationId: string;
  actionKind: TaskPendingActionKind;
  summary: string;
  expiresAt: string;
};

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
  ): Promise<TaskMutationDecisionResult>;
}

export class TaskMutationConfirmationService {
  constructor(
    private readonly store: TaskMutationConfirmationStore,
    private readonly clock: Clock,
    private readonly options: { ttlMilliseconds?: number; confirmationId?: () => string } = {},
  ) {}

  async propose(
    ownerId: string,
    proposal: TaskMutationProposal,
    options: { actionKind?: TaskPendingActionKind } = {},
  ): Promise<PendingTaskMutation> {
    const safeOwnerId = assertOwnerId(ownerId);
    const normalized = normalizeTaskMutationProposal(proposal);
    const actionKind = options.actionKind ?? inferTaskPendingActionKind(normalized);
    if (!taskActionKindMatchesProposal(actionKind, normalized)) throw new Error("task action kind does not match proposal");
    const createdAt = assertTimestamp(this.clock.now());
    const ttl = this.options.ttlMilliseconds ?? 15 * 60_000;
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
    await this.store.save(record);
    return copyPending(record);
  }

  confirm(ownerId: string, confirmationId: string): Promise<TaskMutationDecisionResult> {
    return this.decide(ownerId, confirmationId, "confirm");
  }

  reject(ownerId: string, confirmationId: string): Promise<TaskMutationDecisionResult> {
    return this.decide(ownerId, confirmationId, "reject");
  }

  private decide(ownerId: string, confirmationId: string, decision: "confirm" | "reject"): Promise<TaskMutationDecisionResult> {
    const safeOwnerId = assertOwnerId(ownerId);
    const safeConfirmationId = requiredText.parse(confirmationId);
    return this.store.decide({
      confirmationId: safeConfirmationId,
      ownerId: safeOwnerId,
      decision,
      decidedAt: assertTimestamp(this.clock.now()),
    }, (writer, proposal) => executeTaskMutation(writer, safeOwnerId, proposal));
  }
}

export function pendingTaskAction(record: PendingTaskMutation): PendingTaskAction {
  return {
    confirmationId: record.confirmationId,
    actionKind: record.actionKind,
    summary: boundedSummary(taskActionSummary(record.actionKind, record.proposal), 280),
    expiresAt: record.expiresAt,
  };
}

export function normalizeTaskMutationProposal(proposal: TaskMutationProposal): TaskMutationProposal {
  const parsed = proposalSchema.parse(proposal);
  if (parsed.kind === "create") return { kind: "create", input: { ...parsed.input } };
  if (parsed.kind === "cancel") return { kind: "cancel", taskId: parsed.taskId, expectedRevision: parsed.expectedRevision };
  return { kind: "update", taskId: parsed.taskId, expectedRevision: parsed.expectedRevision, patch: { ...parsed.patch } };
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

export function copyTaskMutationResult(result: TaskMutationResult): TaskMutationResult {
  if (result.outcome === "not_found") return { outcome: "not_found" };
  if (result.outcome === "conflict") return result.current ? { outcome: "conflict", current: copyTask(result.current) } : { outcome: "conflict" };
  return { outcome: result.outcome, task: copyTask(result.task) };
}

function inferTaskPendingActionKind(proposal: TaskMutationProposal): TaskPendingActionKind {
  if (proposal.kind === "create") return proposal.input.originIdeaId === undefined ? "create" : "idea_to_task";
  if (proposal.kind === "cancel") return "cancel";
  return Object.keys(proposal.patch).length === 1 && proposal.patch.status === "done" ? "complete" : "update";
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
