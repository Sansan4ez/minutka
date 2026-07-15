import type { ConversationStore } from "./conversation-store.js";
import type { DocumentStore, UserDocument } from "./document-store.js";
import { assertUserId } from "./document-store.js";
import type { CaptureIdeaInput, CaptureIdeaResult, IngestionService } from "./ingestion-service.js";
import { NO_PROJECT } from "../domain/classification.js";
import { createAssistantContextProjectionBuilder, renderAssistantContextProjection, type AssistantContextProjection } from "./assistant-context-projection.js";
import { createAssistantRecordsProjectionBuilder, renderAssistantRecordsProjection, type AssistantRecordsProjection } from "./assistant-records-projection.js";
import type { IdeaSource, IdeaStore } from "./idea-store.js";
import { safeAuditMetadata, type AuditEventStore } from "./audit-event-store.js";
import { loadAssistantAgentInstructions } from "./assistant-manual-loader.js";
import { PersistenceError } from "./persistence-error.js";
import type { ProfileStore } from "./profile-store.js";
import type { Clock, IdGenerator } from "./runtime-primitives.js";
import { randomIdGenerator, systemClock } from "./runtime-primitives.js";

export type AssistantChatInput = { userId: string; threadId: string; text: string; source?: IdeaSource; inputModality?: "text" | "voice" };
export type AssistantAgentContext = {
  systemContext: string;
  personalContext: AssistantContextProjection;
  records: AssistantRecordsProjection;
  /** Sanitized source metadata for capture; it contains no transport identity. */
  source: IdeaSource;
  /** Typed, reversible owner-scoped action. Source provenance is bound by AssistantService. */
  captureIdea(input: Omit<CaptureIdeaInput, "id" | "userId" | "source">): Promise<CaptureIdeaResult>;
};
export type AssistantAgentRunner = (input: AssistantChatInput, context: AssistantAgentContext) => Promise<string>;
export type AssistantChatResult = { messageId: string; response: string; selectedProcessIds: ["core"] | ["core", "inbox_capture"]; personalContextDocuments?: string[] };

/**
 * Product-level orchestration for the personal assistant.
 * It intentionally owns no persistence implementation and never gives the
 * agent store credentials or a mutable filesystem.
 */
export class AssistantService {
  private readonly projectionBuilder;
  private readonly recordsProjectionBuilder?: ReturnType<typeof createAssistantRecordsProjectionBuilder>;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(
    private readonly agentRunner: AssistantAgentRunner,
    private readonly deps: { documentStore: DocumentStore; conversationStore: ConversationStore; ingestionService: Pick<IngestionService, "saveContextDocument" | "captureIdea">; ideaStore?: IdeaStore; auditEventStore?: AuditEventStore; participantStore?: Pick<ProfileStore, "getParticipant">; clock?: Clock; idGenerator?: IdGenerator; agentInstructions?: string },
  ) {
    this.clock = deps.clock ?? systemClock;
    this.ids = deps.idGenerator ?? randomIdGenerator;
    this.projectionBuilder = createAssistantContextProjectionBuilder({ documentStore: deps.documentStore, now: () => this.clock.now() });
    this.recordsProjectionBuilder = deps.ideaStore === undefined ? undefined : createAssistantRecordsProjectionBuilder({ ideaStore: deps.ideaStore, now: () => this.clock.now() });
  }

  /** Explicit onboarding write: reviewed Markdown flows through the ingestion boundary. */
  async saveOnboardingContext(input: { userId: string; path: string; content: string }): Promise<UserDocument> {
    return this.deps.ingestionService.saveContextDocument(input);
  }

  async chat(input: AssistantChatInput): Promise<AssistantChatResult> {
    const userId = assertUserId(input.userId);
    const threadId = input.threadId.trim();
    const text = input.text.trim();
    const source = input.source ?? { kind: "text", text };
    if (!threadId) throw new Error("threadId is required");
    if (!text) throw new Error("text is required");
    if (this.deps.participantStore && !await this.deps.participantStore.getParticipant(userId)) throw new PersistenceError("participant_not_found");
    const messageId = this.ids.messageId();
    const requestId = this.ids.requestId();
    const inputModality = input.inputModality ?? "text";
    await this.auditSafely({
      id: this.ids.auditEventId(), requestId, type: "chat_received", employeeId: userId, threadId, messageId,
      occurredAt: this.clock.now(), metadata: safeAuditMetadata("chat_received", { inputModality }),
    }, "chat received audit");
    const personalContext = await this.projectionBuilder.build({ userId, requestId });
    const records = await this.recordsProjectionBuilder?.build({ userId, requestId }) ?? emptyRecordsProjection({ userId, requestId, now: this.clock.now() });
    let captureResult: CaptureIdeaResult | undefined;
    const captureIdea = async (idea: Omit<CaptureIdeaInput, "id" | "userId" | "source">) => {
      const captured = await this.deps.ingestionService.captureIdea({ ...idea, id: this.ids.ideaId(), userId, source });
      captureResult = captured;
      if (this.deps.auditEventStore) {
        try {
          await this.deps.auditEventStore.append({
            id: this.ids.auditEventId(),
            requestId,
            type: "idea_captured",
            employeeId: userId,
            threadId,
            messageId,
            occurredAt: this.clock.now(),
            metadata: safeAuditMetadata("idea_captured", {
              ideaId: captured.idea.id,
              recordType: captured.idea.type,
              sourceKind: source.kind,
            }),
          });
        } catch (error) {
          logAssistantOperationalError("idea capture audit", error);
        }
      }
      return captured;
    };
    let response: string | undefined;
    let agentError: unknown;
    try {
      response = await this.agentRunner({ userId, threadId, text }, {
        personalContext,
        records,
        source,
        systemContext: buildAssistantSystemContext(personalContext, records, this.deps.agentInstructions),
        captureIdea,
      });
    } catch (error) {
      agentError = error;
    }
    // Infrastructure failures must not discard owner input. File uploads are
    // also a deterministic capture gate; semantic routing of successful text
    // turns remains the agent's responsibility.
    if (!captureResult && this.deps.ideaStore && (agentError !== undefined || source.kind === "blob")) {
      const fallback = await captureIdea({
        project: NO_PROJECT,
        type: "knowledge",
        summary: text,
        suggestedNextStep: "Уточнить проект и следующий шаг.",
        needsProjectClarification: true,
      });
      if (agentError !== undefined) response = fallback.response;
    }
    if (response !== undefined && !response.trim()) response = undefined;
    if (response === undefined && captureResult) response = captureResult.response;
    if (agentError !== undefined && response === undefined) throw agentError;
    if (response === undefined) throw new Error("Agent returned no response");
    await this.deps.conversationStore.appendTurn({
      messageId,
      // The existing application history store uses employeeId as its neutral
      // owner key. AssistantService maps its trusted userId only at this seam.
      employeeId: userId,
      threadId,
      userText: text,
      agentResponse: response,
      timestamp: this.clock.now(),
    });
    await this.auditSafely({
      id: this.ids.auditEventId(), requestId, type: "chat_response_generated", employeeId: userId, threadId, messageId,
      occurredAt: this.clock.now(), metadata: safeAuditMetadata("chat_response_generated", {}),
    }, "chat response audit");
    const selectedProcessIds: AssistantChatResult["selectedProcessIds"] = captureResult ? ["core", "inbox_capture"] : ["core"];
    return { messageId, response, selectedProcessIds, personalContextDocuments: personalContext.data.documents.map((document) => document.path) };
  }

  private async auditSafely(event: Parameters<AuditEventStore["append"]>[0], operation: string): Promise<void> {
    if (!this.deps.auditEventStore) return;
    try { await this.deps.auditEventStore.append(event); }
    catch (error) { logAssistantOperationalError(operation, error); }
  }
}

export function buildAssistantSystemContext(personalContext: AssistantContextProjection, records?: AssistantRecordsProjection, agentInstructions = loadAssistantAgentInstructions()): string {
  return [
    "# Personal assistant runtime context",
    agentInstructions,
    renderAssistantContextProjection(personalContext),
    ...(records === undefined ? [] : [renderAssistantRecordsProjection(records)]),
  ].filter(Boolean).join("\n\n");
}

function logAssistantOperationalError(operation: string, error: unknown): void {
  console.warn(`Assistant ${operation} failed (${error instanceof Error ? error.name : "UnknownError"}).`);
}

function emptyRecordsProjection(input: { userId: string; requestId: string; now: string }): AssistantRecordsProjection {
  return {
    schemaVersion: 1,
    path: "/proc/records",
    generatedAt: input.now,
    scope: { userId: input.userId, requestId: input.requestId },
    data: { records: [], truncated: false },
  };
}
