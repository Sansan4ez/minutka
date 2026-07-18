import type { ConversationStore } from "./conversation-store.js";
import { applyContextBudget, defaultContextBudget, type ContextBudgetConfig, type ContextBudgetResult } from "./context-budget.js";
import { createOwnerDocumentReader, type DocumentToolAudit } from "./document-reader.js";
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
import type { RuntimeProjectionBuilder } from "./runtime-projections/runtime-projection-builder.js";
import { renderRuntimeProjection } from "./runtime-projections/runtime-projection-renderer.js";
import type { ChatProcSnapshot } from "./runtime-projections/runtime-projection-types.js";
import type { Clock, IdGenerator } from "./runtime-primitives.js";
import { randomIdGenerator, systemClock } from "./runtime-primitives.js";
import type { RequestIntegrityGuard } from "./request-integrity-guard.js";
import type { RequestIntegrityDenialReason } from "../domain/request-integrity.js";
import { createResponsePolicy, renderResponsePolicy, type ResponseChannel } from "../domain/response-policy.js";
import type { ContextPriorityManifest } from "./context-priority-manifest.js";

export type AssistantChatInput = { userId: string; threadId: string; text: string; source?: IdeaSource; inputModality?: "text" | "voice"; responseChannel?: ResponseChannel };
export type AssistantAgentContext = {
  systemContext: string;
  personalContext: AssistantContextProjection;
  profileAndHistory: ChatProcSnapshot;
  records: AssistantRecordsProjection;
  /** Sanitized source metadata for capture; it contains no transport identity. */
  source: IdeaSource;
  /** Typed, reversible owner-scoped action. Source provenance is bound by AssistantService. */
  captureIdea(input: Omit<CaptureIdeaInput, "id" | "userId" | "source">): Promise<CaptureIdeaResult>;
  /** Read-only personal document capabilities bound to the authenticated owner. */
  documents: ReturnType<typeof createOwnerDocumentReader>;
};
export type AssistantAgentRunner = (input: AssistantChatInput, context: AssistantAgentContext) => Promise<string>;
export type AssistantOperationalWarning = Pick<ContextBudgetResult, "used" | "available" | "omittedSourceIds"> & {
  type: "context_budget_overflow";
};
export type AssistantOperationalLogger = (warning: AssistantOperationalWarning) => void;
export type AssistantChatOutcome =
  | { status: "completed" }
  | { status: "denied"; reason: RequestIntegrityDenialReason };
export type AssistantChatResult = {
  messageId: string;
  response: string;
  selectedProcessIds: ["core"] | ["core", "inbox_capture"];
  /** Internal typed outcome for application/audit consumers; transports remain backward-compatible. */
  outcome: AssistantChatOutcome;
  personalContextDocuments?: string[];
};

/**
 * Product-level orchestration for the personal assistant.
 * It intentionally owns no persistence implementation and never gives the
 * agent store credentials or a mutable filesystem.
 */
export class AssistantService {
  private readonly projectionBuilder;
  private readonly recordsProjectionBuilder?: ReturnType<typeof createAssistantRecordsProjectionBuilder>;
  private readonly chatProjectionBuilder?: Pick<RuntimeProjectionBuilder, "buildChatProc">;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;

  constructor(
    private readonly agentRunner: AssistantAgentRunner,
    private readonly deps: { documentStore: DocumentStore; conversationStore: ConversationStore; ingestionService: Pick<IngestionService, "saveContextDocument" | "captureIdea">; requestIntegrityGuard: RequestIntegrityGuard; ideaStore?: IdeaStore; auditEventStore?: AuditEventStore; participantStore?: Pick<ProfileStore, "getParticipant"> & Partial<Pick<ProfileStore, "getProfile">>; chatProjectionBuilder?: Pick<RuntimeProjectionBuilder, "buildChatProc">; clock?: Clock; idGenerator?: IdGenerator; agentInstructions?: string; contextBudget?: ContextBudgetConfig; contextPriorities?: ContextPriorityManifest; operationalLogger?: AssistantOperationalLogger },
  ) {
    this.clock = deps.clock ?? systemClock;
    this.ids = deps.idGenerator ?? randomIdGenerator;
    this.projectionBuilder = createAssistantContextProjectionBuilder({ documentStore: deps.documentStore, now: () => this.clock.now(), contextBudget: deps.contextBudget, contextPriorities: deps.contextPriorities });
    this.recordsProjectionBuilder = deps.ideaStore === undefined ? undefined : createAssistantRecordsProjectionBuilder({ ideaStore: deps.ideaStore, now: () => this.clock.now(), contextBudget: deps.contextBudget });
    this.chatProjectionBuilder = deps.chatProjectionBuilder;
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
    const chatProc = await this.chatProjectionBuilder?.buildChatProc({ employeeId: userId, threadId, requestId, purpose: "chat" });
    const profile = chatProc?.profile ?? (this.deps.participantStore?.getProfile ? await this.deps.participantStore.getProfile(userId) : undefined);
    const profileAndHistory = chatProc?.snapshot ?? emptyChatProcSnapshot({ userId, threadId, requestId, now: this.clock.now(), profile });
    const responsePolicy = createResponsePolicy({ channel: input.responseChannel, preferredLength: profile?.responseLength });
    await this.auditSafely({
      id: this.ids.auditEventId(), requestId, type: "chat_received", employeeId: userId, threadId, messageId,
      occurredAt: this.clock.now(), metadata: safeAuditMetadata("chat_received", { inputModality }),
    }, "chat received audit");
    const integrityOutcome = await this.deps.requestIntegrityGuard({ userId, text });
    if (integrityOutcome.status === "denied") {
      const response = requestIntegrityDenialResponse;
      await this.deps.conversationStore.appendTurn({
        messageId,
        employeeId: userId,
        threadId,
        userText: text,
        agentResponse: response,
        timestamp: this.clock.now(),
      });
      await this.auditSafely({
        id: this.ids.auditEventId(), requestId, type: "request_integrity_denied", employeeId: userId, threadId, messageId,
        occurredAt: this.clock.now(), metadata: safeAuditMetadata("request_integrity_denied", { reason: integrityOutcome.reason }),
      }, "request integrity denial audit");
      await this.auditSafely({
        id: this.ids.auditEventId(), requestId, type: "chat_response_generated", employeeId: userId, threadId, messageId,
        occurredAt: this.clock.now(), metadata: safeAuditMetadata("chat_response_generated", {}),
      }, "chat response audit");
      return {
        messageId,
        response,
        selectedProcessIds: ["core"],
        outcome: { status: "denied", reason: integrityOutcome.reason },
      };
    }
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
    const auditDocumentTool: DocumentToolAudit = async (event) => {
      await this.auditSafely({
        id: this.ids.auditEventId(), requestId, type: "document_tool_used", employeeId: userId, threadId, messageId,
        occurredAt: this.clock.now(), metadata: safeAuditMetadata("document_tool_used", event),
      }, "document tool audit");
    };
    const documents = createOwnerDocumentReader({ userId, documentStore: this.deps.documentStore, audit: auditDocumentTool, contextBudget: this.deps.contextBudget });
    const systemContextBudget = buildAssistantSystemContextBudget(personalContext, records, this.deps.agentInstructions, renderResponsePolicy(responsePolicy), profileAndHistory, text, this.deps.contextBudget);
    if (systemContextBudget.omittedSourceIds.length > 0) {
      this.warnOperationally({
        type: "context_budget_overflow",
        omittedSourceIds: systemContextBudget.omittedSourceIds,
        used: systemContextBudget.used,
        available: systemContextBudget.available,
      });
    }
    let response: string | undefined;
    let agentError: unknown;
    try {
      response = await this.agentRunner({ userId, threadId, text }, {
        personalContext,
        profileAndHistory,
        records,
        source,
        systemContext: systemContextBudget.text,
        captureIdea,
        documents,
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
    return {
      messageId,
      response,
      selectedProcessIds,
      outcome: { status: "completed" },
      personalContextDocuments: personalContext.data.documents.map((document) => document.path),
    };
  }

  private async auditSafely(event: Parameters<AuditEventStore["append"]>[0], operation: string): Promise<void> {
    if (!this.deps.auditEventStore) return;
    try { await this.deps.auditEventStore.append(event); }
    catch (error) { logAssistantOperationalError(operation, error); }
  }

  private warnOperationally(warning: AssistantOperationalWarning): void {
    try { (this.deps.operationalLogger ?? logAssistantOperationalWarning)(warning); }
    catch (error) { logAssistantOperationalError("operational warning", error); }
  }
}

export function buildAssistantSystemContext(
  personalContext: AssistantContextProjection,
  records?: AssistantRecordsProjection,
  agentInstructions = loadAssistantAgentInstructions(),
  responsePolicy?: string,
  profileAndHistory?: ChatProcSnapshot,
  userInput = "",
  contextBudget: ContextBudgetConfig = defaultContextBudget,
): string {
  return buildAssistantSystemContextBudget(personalContext, records, agentInstructions, responsePolicy, profileAndHistory, userInput, contextBudget).text;
}

export function buildAssistantSystemContextBudget(
  personalContext: AssistantContextProjection,
  records?: AssistantRecordsProjection,
  agentInstructions = loadAssistantAgentInstructions(),
  responsePolicy?: string,
  profileAndHistory?: ChatProcSnapshot,
  userInput = "",
  contextBudget: ContextBudgetConfig = defaultContextBudget,
): ContextBudgetResult {
  const runtimeProjection = profileAndHistory === undefined ? undefined : renderRuntimeProjection(profileAndHistory);
  const profileSection = runtimeProjection === undefined ? undefined : extractRuntimeProjectionSection(runtimeProjection, "/proc/profile");
  const historySection = runtimeProjection === undefined ? undefined : extractRuntimeProjectionSection(runtimeProjection, "/proc/thread");
  return applyContextBudget({
    userInput,
    config: contextBudget,
    sections: [
      { sourceId: "base_instructions", content: "# Personal assistant runtime context" },
      { sourceId: "agent_manual", content: [agentInstructions, responsePolicy].filter(Boolean).join("\n\n") },
      { sourceId: "profile", content: profileSection ?? "" },
      { sourceId: "context", content: renderAssistantContextProjection(personalContext) },
      ...(records === undefined ? [] : [{ sourceId: "records" as const, content: renderAssistantRecordsProjection(records) }]),
      { sourceId: "history", content: historySection ?? "" },
    ],
  });
}

function extractRuntimeProjectionSection(rendered: string, path: "/proc/profile" | "/proc/thread"): string | undefined {
  const heading = `## Runtime projection: ${path}`;
  const start = rendered.indexOf(heading);
  if (start < 0) return undefined;
  const next = rendered.indexOf("\n\n## Runtime projection:", start + heading.length);
  return rendered.slice(start, next < 0 ? rendered.length : next);
}

const requestIntegrityDenialResponse = "Не могу выполнить эту часть запроса. Могу помочь с безопасной формулировкой или с самой рабочей задачей без изменения правил и полномочий.";

function logAssistantOperationalWarning(warning: AssistantOperationalWarning): void {
  console.warn("Assistant operational warning.", warning);
}

function logAssistantOperationalError(operation: string, error: unknown): void {
  console.warn(`Assistant ${operation} failed (${error instanceof Error ? error.name : "UnknownError"}).`);
}

function emptyChatProcSnapshot(input: { userId: string; threadId: string; requestId: string; now: string; profile?: Awaited<ReturnType<ProfileStore["getProfile"]>> }): ChatProcSnapshot {
  const scope = { employeeId: input.userId, threadId: input.threadId, requestId: input.requestId, purpose: "chat" as const };
  const profile = input.profile ? {
    preferredName: input.profile.preferredName,
    assistantName: input.profile.assistantName,
    addressForm: input.profile.addressForm,
    persona: input.profile.persona,
    responseLength: input.profile.responseLength,
    timezone: input.profile.timezone,
    ...(input.profile.role ? { role: input.profile.role } : {}),
    ...(input.profile.typicalTasks ? { typicalTasks: [...input.profile.typicalTasks] } : {}),
    ...(input.profile.aiLevel ? { aiLevel: input.profile.aiLevel } : {}),
    ...(input.profile.preferredCheckinsPerDay ? { preferredCheckinsPerDay: input.profile.preferredCheckinsPerDay } : {}),
  } : null;
  return {
    profile: { schemaVersion: 1, path: "/proc/profile", generatedAt: input.now, scope, data: profile },
    thread: { schemaVersion: 1, path: "/proc/thread", generatedAt: input.now, scope, data: { turns: [], truncated: false } },
  };
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
