import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { safeAuditMetadata, type AuditEventStore } from "./audit-event-store.js";
import { assertContextDocumentWithinMaximumBytes } from "./context-document-size.js";
import {
  assertUserId,
  contextDocumentHandle,
  contextDocumentPath,
  type DocumentDeleteResult,
  type DocumentMoveResult,
  type DocumentStore,
  type DocumentUpdateResult,
} from "./document-store.js";
import { defaultContextBudget } from "./context-budget.js";
import type { Clock, IdGenerator } from "./runtime-primitives.js";
import { safeConfirmationDisplayText, type PendingTaskPreviewText } from "./task-mutation-confirmation.js";

export const contextDocumentConfirmationTtlMilliseconds = 15 * 60_000;
export const contextDocumentConfirmationPurgeBatchSize = 500;
export const contextDocumentPreviewMaximumCharacters = 1_200;
export const writableContextDocumentSections = [
  "00_inbox", "07_rfcs", "08_entities", "10_user_memory", "20_work",
  "30_knowledge", "40_projects", "50_finance", "60_outbox", "90_agent_memory",
] as const;

const requiredText = z.string().refine((value) => value.trim().length > 0, "Required text");
const versionSchema = requiredText.max(512);

export type ContextDocumentPatch = { search: string; replacement: string };
export type ContextDocumentMutationProposal =
  | { kind: "update"; path: string; expectedVersion: string; content: string }
  | { kind: "move"; sourcePath: string; destinationPath: string; expectedVersion: string }
  | { kind: "delete"; path: string; expectedVersion: string };

export type ContextDocumentMutationOutcome =
  | { outcome: "updated"; path: string; version: string }
  | { outcome: "moved"; sourcePath: string; destinationPath: string; version: string; sourceVersion: string }
  | { outcome: "deleted"; path: string; restoreVersion: string }
  | { outcome: "not_found" | "conflict" | "destination_conflict"; path: string; currentVersion?: string };

export type PendingContextDocumentMutation = {
  confirmationId: string;
  ownerId: string;
  proposal: ContextDocumentMutationProposal;
  payloadDigest: string;
  createdAt: string;
  expiresAt: string;
};

export type PendingContextDocumentMutationRecord = PendingContextDocumentMutation & {
  decision?: "confirmed" | "rejected";
  outcome?: ContextDocumentMutationOutcome;
  completedAt?: string;
};

export type PendingContextDocumentMutationReceipt = {
  confirmationId: string;
  actionKind: ContextDocumentMutationProposal["kind"];
  summary: string;
  expiresAt: string;
  preview: {
    path: `/proc/context/${string}`;
    destination?: `/proc/context/${string}`;
    change?: PendingTaskPreviewText;
  };
};

export type ContextDocumentDecisionResult =
  | { status: "confirmed" | "already_confirmed"; outcome: ContextDocumentMutationOutcome }
  | { status: "rejected" | "already_rejected" }
  | { status: "not_found" | "owner_mismatch" | "expired" | "invalid_payload" };

export interface ContextDocumentConfirmationStore {
  save(record: PendingContextDocumentMutation): Promise<void>;
  decide(
    input: { confirmationId: string; ownerId: string; decision: "confirm" | "reject"; decidedAt: string },
    effect: (proposal: ContextDocumentMutationProposal) => Promise<ContextDocumentMutationOutcome>,
  ): Promise<{ result: ContextDocumentDecisionResult; proposal?: ContextDocumentMutationProposal }>;
  purge(input: { pendingExpiredBefore: string; completedBefore: string; limit: number }): Promise<number>;
}

export type ContextDocumentAuditContext = { requestId: string; threadId?: string; messageId?: string };

export class ContextDocumentService {
  private readonly maximumDocumentBytes: number;

  constructor(
    private readonly documents: DocumentStore,
    private readonly confirmations: ContextDocumentConfirmationStore,
    private readonly clock: Clock,
    private readonly options: {
      maximumDocumentBytes?: number;
      confirmationTtlMilliseconds?: number;
      confirmationId?: () => string;
      auditEventStore?: AuditEventStore;
      idGenerator?: Pick<IdGenerator, "auditEventId">;
    } = {},
  ) {
    this.maximumDocumentBytes = options.maximumDocumentBytes ?? defaultContextBudget.documentTools.maximumDocumentBytes;
  }

  async createNote(ownerId: string, input: { title: string; content: string; destination?: string }, audit?: ContextDocumentAuditContext): Promise<
    | { outcome: "created"; path: `/proc/context/${string}`; version: string }
    | { outcome: "conflict"; path: `/proc/context/${string}`; currentVersion: string }
  > {
    const safeOwnerId = assertUserId(ownerId);
    const title = requiredText.parse(input.title).trim();
    const content = requiredContent(input.content, this.maximumDocumentBytes);
    const destination = normalizeDestination(input.destination ?? "00_inbox");
    const path = `context/${destination}/${noteFileName(title)}`;
    const existing = await this.documents.head(safeOwnerId, path);
    if (existing) {
      await this.auditSafely("create", safeOwnerId, path, "conflict", existing.version, undefined, audit);
      return { outcome: "conflict", path: contextDocumentHandle(path), currentVersion: existing.version };
    }
    const created = await this.documents.putIfAbsent(safeOwnerId, path, content);
    const outcome = created.content === content && created.path === path ? "created" : "conflict";
    await this.auditSafely("create", safeOwnerId, path, outcome, created.version, undefined, audit);
    return outcome === "created"
      ? { outcome, path: contextDocumentHandle(path), version: created.version }
      : { outcome, path: contextDocumentHandle(path), currentVersion: created.version };
  }

  async proposeUpdate(ownerId: string, input: {
    path: string;
    expectedVersion: string;
    replacement?: string;
    patch?: ContextDocumentPatch;
  }, audit?: ContextDocumentAuditContext): Promise<ProposalResult> {
    const safeOwnerId = assertUserId(ownerId);
    const path = contextDocumentPath(input.path);
    const expectedVersion = versionSchema.parse(input.expectedVersion);
    const current = await this.documents.get(safeOwnerId, path);
    if (!current) return { status: "not_found" };
    if (current.version !== expectedVersion) return { status: "conflict", currentVersion: current.version };
    const content = replacementContent(current.content, input, this.maximumDocumentBytes);
    const proposal: ContextDocumentMutationProposal = { kind: "update", path, expectedVersion, content };
    return this.saveProposal(safeOwnerId, proposal, boundedChangePreview(current.content, content), audit);
  }

  async proposeMove(ownerId: string, input: { path: string; destination: string; expectedVersion: string }, audit?: ContextDocumentAuditContext): Promise<ProposalResult> {
    const safeOwnerId = assertUserId(ownerId);
    const sourcePath = contextDocumentPath(input.path);
    const destinationPath = contextDocumentPath(input.destination);
    if (sourcePath === destinationPath) throw new Error("move destination must differ from source");
    const expectedVersion = versionSchema.parse(input.expectedVersion);
    const current = await this.documents.head(safeOwnerId, sourcePath);
    if (!current) return { status: "not_found" };
    if (current.version !== expectedVersion) return { status: "conflict", currentVersion: current.version };
    const destination = await this.documents.head(safeOwnerId, destinationPath);
    if (destination) return { status: "destination_conflict", currentVersion: destination.version };
    return this.saveProposal(safeOwnerId, { kind: "move", sourcePath, destinationPath, expectedVersion }, undefined, audit);
  }

  async proposeDelete(ownerId: string, input: { path: string; expectedVersion: string }, audit?: ContextDocumentAuditContext): Promise<ProposalResult> {
    const safeOwnerId = assertUserId(ownerId);
    const path = contextDocumentPath(input.path);
    const expectedVersion = versionSchema.parse(input.expectedVersion);
    const current = await this.documents.head(safeOwnerId, path);
    if (!current) return { status: "not_found" };
    if (current.version !== expectedVersion) return { status: "conflict", currentVersion: current.version };
    return this.saveProposal(safeOwnerId, { kind: "delete", path, expectedVersion }, undefined, audit);
  }

  confirm(ownerId: string, confirmationId: string, audit?: ContextDocumentAuditContext): Promise<ContextDocumentDecisionResult> {
    return this.decide(ownerId, confirmationId, "confirm", audit);
  }

  reject(ownerId: string, confirmationId: string, audit?: ContextDocumentAuditContext): Promise<ContextDocumentDecisionResult> {
    return this.decide(ownerId, confirmationId, "reject", audit);
  }

  async restoreVersion(ownerId: string, input: { path: string; version: string }, audit?: ContextDocumentAuditContext): Promise<
    | { outcome: "restored"; path: `/proc/context/${string}`; version: string }
    | { outcome: "not_found"; path: `/proc/context/${string}` }
  > {
    const safeOwnerId = assertUserId(ownerId);
    const path = contextDocumentPath(input.path);
    const version = versionSchema.parse(input.version);
    const restored = await this.documents.restoreVersion(safeOwnerId, path, version);
    await this.auditSafely("restore", safeOwnerId, path, restored ? "restored" : "not_found", restored?.version, undefined, audit);
    return restored
      ? { outcome: "restored", path: contextDocumentHandle(path), version: restored.version }
      : { outcome: "not_found", path: contextDocumentHandle(path) };
  }

  purge(input: { completedReplayRetentionMilliseconds: number; limit?: number; now?: string }): Promise<number> {
    const retention = positiveSafeInteger(input.completedReplayRetentionMilliseconds, "completed replay retention");
    const ttl = this.options.confirmationTtlMilliseconds ?? contextDocumentConfirmationTtlMilliseconds;
    if (retention <= ttl) throw new Error("completed replay retention must exceed the confirmation TTL");
    const limit = positiveSafeInteger(input.limit ?? contextDocumentConfirmationPurgeBatchSize, "confirmation purge limit");
    const now = timestamp(input.now ?? this.clock.now());
    return this.confirmations.purge({
      pendingExpiredBefore: now,
      completedBefore: new Date(Date.parse(now) - retention).toISOString(),
      limit,
    });
  }

  private async saveProposal(ownerId: string, proposal: ContextDocumentMutationProposal, change: PendingTaskPreviewText | undefined, audit?: ContextDocumentAuditContext): Promise<ProposalResult> {
    const createdAt = timestamp(this.clock.now());
    const ttl = positiveSafeInteger(this.options.confirmationTtlMilliseconds ?? contextDocumentConfirmationTtlMilliseconds, "confirmation ttl");
    const record: PendingContextDocumentMutation = {
      confirmationId: requiredText.parse((this.options.confirmationId ?? (() => `context-document-${randomUUID()}`))()),
      ownerId,
      proposal: normalizeContextDocumentProposal(proposal),
      payloadDigest: contextDocumentPayloadDigest(proposal),
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + ttl).toISOString(),
    };
    await this.confirmations.save(record);
    await this.auditSafely(proposal.kind, ownerId, proposalPath(proposal), "pending", undefined, record.confirmationId, audit);
    return { status: "needs_confirmation", confirmation: pendingContextDocumentMutationReceipt(record, change) };
  }

  private async decide(ownerId: string, confirmationId: string, decision: "confirm" | "reject", audit?: ContextDocumentAuditContext): Promise<ContextDocumentDecisionResult> {
    const safeOwnerId = assertUserId(ownerId);
    const safeConfirmationId = requiredText.parse(confirmationId);
    const decided = await this.confirmations.decide({
      confirmationId: safeConfirmationId,
      ownerId: safeOwnerId,
      decision,
      decidedAt: timestamp(this.clock.now()),
    }, (proposal) => this.execute(safeOwnerId, proposal));
    const proposal = decided.proposal;
    if (proposal && ["confirmed", "already_confirmed", "rejected", "already_rejected"].includes(decided.result.status)) {
      const outcome = decided.result.status === "confirmed" || decided.result.status === "already_confirmed"
        ? decided.result.outcome.outcome
        : decided.result.status;
      const version = decided.result.status === "confirmed" || decided.result.status === "already_confirmed"
        ? outcomeVersion(decided.result.outcome)
        : undefined;
      await this.auditSafely(proposal.kind, safeOwnerId, proposalPath(proposal), outcome, version, safeConfirmationId, audit);
    }
    return decided.result;
  }

  private async execute(ownerId: string, proposal: ContextDocumentMutationProposal): Promise<ContextDocumentMutationOutcome> {
    switch (proposal.kind) {
      case "update": {
        const result = await this.documents.putIfVersion(ownerId, proposal.path, proposal.expectedVersion, proposal.content);
        if (result.outcome === "conflict") {
          const current = await this.documents.get(ownerId, proposal.path);
          if (current?.content === proposal.content) return { outcome: "updated", path: proposal.path, version: current.version };
        }
        return updateOutcome(proposal.path, result);
      }
      case "move": {
        const result = await this.documents.moveIfVersion(ownerId, proposal.sourcePath, proposal.destinationPath, proposal.expectedVersion);
        if (result.outcome === "not_found") {
          const destination = await this.documents.get(ownerId, proposal.destinationPath);
          if (destination) return { outcome: "moved", sourcePath: proposal.sourcePath, destinationPath: proposal.destinationPath, version: destination.version, sourceVersion: proposal.expectedVersion };
        }
        return moveOutcome(proposal, result);
      }
      case "delete": return deleteOutcome(proposal.path, proposal.expectedVersion, await this.documents.deleteIfVersion(ownerId, proposal.path, proposal.expectedVersion));
    }
  }

  private async auditSafely(operation: string, ownerId: string, path: string, outcome: string, version?: string, confirmationId?: string, context?: ContextDocumentAuditContext): Promise<void> {
    if (!this.options.auditEventStore || !this.options.idGenerator) return;
    try {
      await this.options.auditEventStore.append({
        id: this.options.idGenerator.auditEventId(),
        requestId: context?.requestId ?? `context-document:${confirmationId ?? pathDigest(path)}`,
        type: "context_document_mutated",
        employeeId: ownerId,
        ...(context?.threadId ? { threadId: context.threadId } : {}),
        ...(context?.messageId ? { messageId: context.messageId } : {}),
        occurredAt: this.clock.now(),
        metadata: safeAuditMetadata("context_document_mutated", {
          operation,
          path: contextDocumentHandle(path),
          outcome,
          ...(version ? { version } : {}),
          ...(confirmationId ? { confirmationId } : {}),
        }),
      });
    } catch {
      // Metadata-only audit is diagnostic and must not change document semantics.
    }
  }
}

export type ProposalResult =
  | { status: "needs_confirmation"; confirmation: PendingContextDocumentMutationReceipt }
  | { status: "not_found" }
  | { status: "conflict" | "destination_conflict"; currentVersion: string };

export function pendingContextDocumentMutationReceipt(record: PendingContextDocumentMutation, change?: PendingTaskPreviewText): PendingContextDocumentMutationReceipt {
  const proposal = record.proposal;
  const path = proposalPath(proposal);
  return {
    confirmationId: record.confirmationId,
    actionKind: proposal.kind,
    summary: boundedSummary(proposal.kind === "move" ? `Переместить ${contextDocumentHandle(path)} в ${contextDocumentHandle(proposal.destinationPath)}` : `${proposal.kind === "update" ? "Изменить" : "Удалить"} ${contextDocumentHandle(path)}`),
    expiresAt: record.expiresAt,
    preview: {
      path: contextDocumentHandle(path),
      ...(proposal.kind === "move" ? { destination: contextDocumentHandle(proposal.destinationPath) } : {}),
      ...(change ? { change } : {}),
    },
  };
}

export function normalizeContextDocumentProposal(proposal: ContextDocumentMutationProposal): ContextDocumentMutationProposal {
  if (proposal.kind === "update") return {
    kind: "update",
    path: contextDocumentPath(contextDocumentHandle(proposal.path)),
    expectedVersion: versionSchema.parse(proposal.expectedVersion),
    content: requiredProposalContent(proposal.content),
  };
  if (proposal.kind === "move") {
    const sourcePath = contextDocumentPath(contextDocumentHandle(proposal.sourcePath));
    const destinationPath = contextDocumentPath(contextDocumentHandle(proposal.destinationPath));
    if (sourcePath === destinationPath) throw new Error("move destination must differ from source");
    return { kind: "move", sourcePath, destinationPath, expectedVersion: versionSchema.parse(proposal.expectedVersion) };
  }
  return { kind: "delete", path: contextDocumentPath(contextDocumentHandle(proposal.path)), expectedVersion: versionSchema.parse(proposal.expectedVersion) };
}

export function contextDocumentPayloadDigest(proposal: ContextDocumentMutationProposal): string {
  return createHash("sha256").update(stableJson(normalizeContextDocumentProposal(proposal))).digest("hex");
}

export function copyContextDocumentOutcome(outcome: ContextDocumentMutationOutcome): ContextDocumentMutationOutcome {
  return { ...outcome };
}

function replacementContent(current: string, input: { replacement?: string; patch?: ContextDocumentPatch }, maximumBytes: number): string {
  const hasReplacement = input.replacement !== undefined;
  const hasPatch = input.patch !== undefined;
  if (hasReplacement === hasPatch) throw new Error("provide exactly one replacement or patch");
  if (hasReplacement) return requiredContent(input.replacement!, maximumBytes);
  const search = requiredText.parse(input.patch!.search);
  const first = current.indexOf(search);
  if (first < 0) throw new Error("patch search text was not found");
  if (current.indexOf(search, first + search.length) >= 0) throw new Error("patch search text must match exactly once");
  return requiredContent(`${current.slice(0, first)}${input.patch!.replacement}${current.slice(first + search.length)}`, maximumBytes);
}

function requiredContent(content: string, maximumBytes: number): string {
  const required = requiredProposalContent(content);
  assertContextDocumentWithinMaximumBytes({ content: required, maximumBytes, description: "context document" });
  return required;
}

function requiredProposalContent(content: string): string {
  if (!content.trim()) throw new Error("context document content is required");
  return content;
}

function normalizeDestination(value: string): string {
  const destination = requiredText.parse(value).trim();
  if (!writableContextDocumentSections.includes(destination as typeof writableContextDocumentSections[number])) {
    throw new Error("destination must be an allow-listed context section");
  }
  return destination;
}

function noteFileName(title: string): string {
  const base = title.normalize("NFKC").toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96)
    .replace(/-+$/g, "");
  if (!base) throw new Error("title must contain letters or numbers");
  return `${base}.md`;
}

function boundedChangePreview(before: string, after: string): PendingTaskPreviewText {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < beforeLines.length - prefix && suffix < afterLines.length - prefix
    && beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]) suffix += 1;
  const removed = beforeLines.slice(prefix, beforeLines.length - suffix).map((line) => `- ${line}`);
  const added = afterLines.slice(prefix, afterLines.length - suffix).map((line) => `+ ${line}`);
  const raw = [...removed, ...added].join("\n") || "Без текстовых изменений";
  const safelyBounded = safeConfirmationDisplayText([...raw].slice(0, contextDocumentPreviewMaximumCharacters).join(""));
  return { value: safelyBounded.value, truncated: safelyBounded.truncated || [...raw].length > contextDocumentPreviewMaximumCharacters };
}

function updateOutcome(path: string, result: DocumentUpdateResult): ContextDocumentMutationOutcome {
  if (result.outcome === "updated") return { outcome: "updated", path, version: result.document.version };
  return { outcome: result.outcome, path, ...("current" in result && result.current ? { currentVersion: result.current.version } : {}) };
}

function moveOutcome(proposal: Extract<ContextDocumentMutationProposal, { kind: "move" }>, result: DocumentMoveResult): ContextDocumentMutationOutcome {
  if (result.outcome === "moved") return { outcome: "moved", sourcePath: proposal.sourcePath, destinationPath: proposal.destinationPath, version: result.document.version, sourceVersion: result.sourceVersion };
  const path = result.outcome === "destination_conflict" ? proposal.destinationPath : proposal.sourcePath;
  return { outcome: result.outcome, path, ...("current" in result && result.current ? { currentVersion: result.current.version } : {}) };
}

function deleteOutcome(path: string, expectedVersion: string, result: DocumentDeleteResult): ContextDocumentMutationOutcome {
  if (result.outcome === "deleted") return { outcome: "deleted", path, restoreVersion: result.version };
  if (result.outcome === "not_found") return { outcome: "deleted", path, restoreVersion: expectedVersion };
  return { outcome: "conflict", path, ...(result.current ? { currentVersion: result.current.version } : {}) };
}

function outcomeVersion(outcome: ContextDocumentMutationOutcome): string | undefined {
  if (outcome.outcome === "updated" || outcome.outcome === "moved") return outcome.version;
  if (outcome.outcome === "deleted") return outcome.restoreVersion;
  return outcome.currentVersion;
}

function proposalPath(proposal: ContextDocumentMutationProposal): string {
  return proposal.kind === "move" ? proposal.sourcePath : proposal.path;
}

function pathDigest(path: string): string { return createHash("sha256").update(path).digest("hex").slice(0, 16); }
function timestamp(value: string): string { if (!Number.isFinite(Date.parse(value))) throw new Error("valid timestamp is required"); return value; }
function positiveSafeInteger(value: number, name: string): number { if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`); return value; }
function boundedSummary(value: string): string { const chars = [...value.trim().replace(/\s+/g, " ")]; return chars.length <= 280 ? chars.join("") : `${chars.slice(0, 279).join("")}…`; }
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
