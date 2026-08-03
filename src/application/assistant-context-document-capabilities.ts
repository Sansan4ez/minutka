import { writableContextDocumentSections } from "./context-document-service.js";
import type {
  ContextDocumentAuditContext,
  ContextDocumentService,
  PendingContextDocumentMutationReceipt,
  ProposalResult,
} from "./context-document-service.js";

export const assistantWritableContextSections = writableContextDocumentSections;

export type AssistantWritableContextSection = typeof assistantWritableContextSections[number];
export type ModelVisibleContextDocumentConfirmation = Pick<
  PendingContextDocumentMutationReceipt,
  "confirmationId" | "actionKind" | "summary" | "expiresAt"
>;
export type AssistantContextDocumentProposalResult =
  | { status: "needs_confirmation"; confirmation: ModelVisibleContextDocumentConfirmation }
  | Exclude<ProposalResult, { status: "needs_confirmation" }>;

export type AssistantContextDocumentCapabilities = {
  createNote(input: { title: string; content: string; destination?: AssistantWritableContextSection }): ReturnType<ContextDocumentService["createNote"]>;
  proposeUpdate(input: { path: string; expectedVersion: string; replacement?: string; patch?: { search: string; replacement: string } }): Promise<AssistantContextDocumentProposalResult>;
  proposeMove(input: { path: string; destination: string; expectedVersion: string }): Promise<AssistantContextDocumentProposalResult>;
  proposeDelete(input: { path: string; expectedVersion: string }): Promise<AssistantContextDocumentProposalResult>;
};

/** Owner-bound model capability: create is an explicit reversible write; all existing-document mutations are proposal-only. */
export function createAssistantContextDocumentCapabilities(input: {
  ownerId: string;
  service?: Pick<ContextDocumentService, "createNote" | "proposeUpdate" | "proposeMove" | "proposeDelete">;
  audit?: ContextDocumentAuditContext;
  reserveProposal(): void;
  releaseProposal(): void;
  onProposal(confirmation: PendingContextDocumentMutationReceipt): void;
  onCreate(outcome: Awaited<ReturnType<ContextDocumentService["createNote"]>>): void;
}): AssistantContextDocumentCapabilities {
  const service = () => {
    if (!input.service) throw new Error("context document mutation is not configured");
    return input.service;
  };
  const proposal = async (action: () => Promise<ProposalResult>): Promise<AssistantContextDocumentProposalResult> => {
    input.reserveProposal();
    let result: ProposalResult;
    try {
      result = await action();
    } catch (error) {
      input.releaseProposal();
      throw error;
    }
    if (result.status !== "needs_confirmation") {
      input.releaseProposal();
      return result;
    }
    input.onProposal(result.confirmation);
    return { status: result.status, confirmation: modelVisibleReceipt(result.confirmation) };
  };
  return {
    async createNote(note) {
      const result = await service().createNote(input.ownerId, note, input.audit);
      input.onCreate(result);
      return result;
    },
    proposeUpdate(update) {
      return proposal(() => service().proposeUpdate(input.ownerId, update, input.audit));
    },
    proposeMove(move) {
      assertWritableDestination(move.destination);
      return proposal(() => service().proposeMove(input.ownerId, move, input.audit));
    },
    proposeDelete(deletion) {
      return proposal(() => service().proposeDelete(input.ownerId, deletion, input.audit));
    },
  };
}

function modelVisibleReceipt(confirmation: PendingContextDocumentMutationReceipt): ModelVisibleContextDocumentConfirmation {
  return {
    confirmationId: confirmation.confirmationId,
    actionKind: confirmation.actionKind,
    summary: confirmation.summary,
    expiresAt: confirmation.expiresAt,
  };
}

function assertWritableDestination(path: string): void {
  const match = /^\/proc\/context\/([^/]+)\//u.exec(path.trim());
  if (!match || !assistantWritableContextSections.includes(match[1] as AssistantWritableContextSection)) {
    throw new Error("destination must stay inside an allow-listed context section");
  }
}
