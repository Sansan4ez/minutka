import type { ConversationStore } from "./conversation-store.js";
import { applyContextBudget, defaultContextBudget, sourceCharacterCeiling, type ContextBudgetConfig, type ContextBudgetResult } from "./context-budget.js";
import { AssistantContextOverflowError, classifyProviderContextOverflow, createOverflowRecoveryContextBudget, overflowAfterPendingActionUserMessage } from "./assistant-overflow-recovery.js";
import { AssistantMutationOutcomeUnknownError, type AssistantChatEffectState } from "./assistant-mutation-outcome.js";
import { createOwnerDocumentReader, type DocumentToolAudit } from "./document-reader.js";
import type { DocumentStore, UserDocument } from "./document-store.js";
import { assertUserId } from "./document-store.js";
import type { CaptureIdeaInput, CaptureIdeaResult, IngestionService } from "./ingestion-service.js";
import { NO_PROJECT } from "../domain/classification.js";
import { createAssistantContextProjectionBuilder, renderAssistantContextIndex, renderAssistantContextProjection, type AssistantContextProjection, type ContextProjectionAudit } from "./assistant-context-projection.js";
import { createAssistantRecordsProjectionBuilder, renderAssistantRecordsProjection, type AssistantRecordsProjection } from "./assistant-records-projection.js";
import type { IdeaSource, IdeaStore } from "./idea-store.js";
import { safeAuditMetadata, type AuditEventStore } from "./audit-event-store.js";
import { loadAssistantAgentInstructions } from "./assistant-manual-loader.js";
import { PersistenceError } from "./persistence-error.js";
import type { ProfileStore } from "./profile-store.js";
import { boundRecentHistory, type RuntimeProjectionBuilder } from "./runtime-projections/runtime-projection-builder.js";
import { renderRecentHistoryProjection, renderRuntimeProfileProjection, renderThreadSummaryProjection } from "./runtime-projections/runtime-projection-renderer.js";
import type { ChatProcSnapshot } from "./runtime-projections/runtime-projection-types.js";
import type { Clock, IdGenerator } from "./runtime-primitives.js";
import { randomIdGenerator, systemClock } from "./runtime-primitives.js";
import type { RequestIntegrityGuard } from "./request-integrity-guard.js";
import type { RequestIntegrityDenialReason } from "../domain/request-integrity.js";
import { createResponsePolicy, renderResponsePolicy, type ResponseChannel } from "../domain/response-policy.js";
import type { ContextPriorityManifest } from "./context-priority-manifest.js";
import type { ThreadCompactionService } from "./thread-compaction-service.js";
import type { TaskReader } from "./task-store.js";
import type { IdeaToTaskService } from "./idea-to-task.js";
import { pendingTaskAction, type PendingTaskAction, type PendingTaskMutation, type TaskMutationConfirmationService } from "./task-mutation-confirmation.js";
import { createAssistantTaskCapabilities, type AssistantTaskCapabilities } from "./assistant-task-capabilities.js";
import { renderAssistantAgentManual, renderAssistantBaseInstructions } from "./assistant-static-context.js";
import { calendarDateInIanaTimezone } from "../shared/iana-timezone.js";
import { isAssistantDiagnosticProcessId, isAssistantProcessId, type AssistantDiagnosticProcessId, type AssistantProcessId } from "../domain/assistant-process.js";

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
  /** Owner-bound task reads and proposals. Execution is an authenticated application command. */
  tasks: AssistantTaskCapabilities;
  /** Request-scoped diagnostic evidence only; it grants no capability or authority. */
  markProcessUsed(id: AssistantDiagnosticProcessId): void;
};
export type AssistantExecutionTraceEvent =
  | { kind: "tool"; toolName: string }
  | { kind: "process"; processId: string };
export type AssistantExecutionTrace = readonly AssistantExecutionTraceEvent[];
export type AssistantAgentRunResult = { text: string; executionTrace: AssistantExecutionTrace };
export type AssistantAgentRunner = (input: AssistantChatInput, context: AssistantAgentContext) => Promise<AssistantAgentRunResult>;
type AssistantServiceRunner = (input: AssistantChatInput, context: AssistantAgentContext) => Promise<AssistantAgentRunResult | string>;
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
  selectedProcessIds: AssistantProcessId[];
  /** Internal typed outcome for application/audit consumers; transports remain backward-compatible. */
  outcome: AssistantChatOutcome;
  personalContextDocuments?: string[];
  pendingAction?: PendingTaskAction;
  /** Explicit recovery state: a proposal is durable but is not a business mutation. */
  effect: AssistantChatEffectState;
};

/**
 * Product-level orchestration for the personal assistant.
 * It intentionally owns no persistence implementation and never gives the
 * agent store credentials or a mutable filesystem.
 */
export class AssistantService {
  private readonly projectionBuilder;
  private readonly overflowProjectionBuilder;
  private readonly recordsProjectionBuilder?: ReturnType<typeof createAssistantRecordsProjectionBuilder>;
  private readonly overflowRecordsProjectionBuilder?: ReturnType<typeof createAssistantRecordsProjectionBuilder>;
  private readonly chatProjectionBuilder?: Pick<RuntimeProjectionBuilder, "buildChatProc">;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly contextBudget: ContextBudgetConfig;
  private readonly overflowRecoveryContextBudget: ContextBudgetConfig;

  constructor(
    private readonly agentRunner: AssistantServiceRunner,
    private readonly deps: { documentStore: DocumentStore; conversationStore: ConversationStore; ingestionService: Pick<IngestionService, "saveContextDocument" | "captureIdea">; requestIntegrityGuard: RequestIntegrityGuard; ideaStore?: IdeaStore; taskStore?: TaskReader; taskMutations?: Pick<TaskMutationConfirmationService, "propose">; ideaToTask?: Pick<IdeaToTaskService, "propose">; auditEventStore?: AuditEventStore; participantStore?: Pick<ProfileStore, "getParticipant"> & Partial<Pick<ProfileStore, "getProfile">>; chatProjectionBuilder?: Pick<RuntimeProjectionBuilder, "buildChatProc">; threadCompactionService?: ThreadCompactionService; clock?: Clock; idGenerator?: IdGenerator; agentInstructions?: string; contextBudget?: ContextBudgetConfig; contextPriorities?: ContextPriorityManifest; operationalLogger?: AssistantOperationalLogger },
  ) {
    this.clock = deps.clock ?? systemClock;
    this.ids = deps.idGenerator ?? randomIdGenerator;
    this.contextBudget = deps.contextBudget ?? defaultContextBudget;
    this.overflowRecoveryContextBudget = createOverflowRecoveryContextBudget(this.contextBudget);
    this.projectionBuilder = createAssistantContextProjectionBuilder({ documentStore: deps.documentStore, now: () => this.clock.now(), contextBudget: this.contextBudget, contextPriorities: deps.contextPriorities });
    this.overflowProjectionBuilder = createAssistantContextProjectionBuilder({ documentStore: deps.documentStore, now: () => this.clock.now(), contextBudget: this.overflowRecoveryContextBudget, contextPriorities: deps.contextPriorities });
    const hasRecordsStore = deps.ideaStore !== undefined || deps.taskStore !== undefined;
    this.recordsProjectionBuilder = hasRecordsStore ? createAssistantRecordsProjectionBuilder({ ideaStore: deps.ideaStore, taskStore: deps.taskStore, now: () => this.clock.now(), contextBudget: this.contextBudget }) : undefined;
    this.overflowRecordsProjectionBuilder = hasRecordsStore ? createAssistantRecordsProjectionBuilder({ ideaStore: deps.ideaStore, taskStore: deps.taskStore, now: () => this.clock.now(), contextBudget: this.overflowRecoveryContextBudget }) : undefined;
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
    const ownerToday = calendarDateInIanaTimezone(this.clock.now(), profile?.timezone ?? chatProc?.snapshot.profile.data?.timezone ?? "Etc/UTC");
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
      this.scheduleThreadCompaction({ employeeId: userId, threadId, requestId });
      return {
        messageId,
        response,
        selectedProcessIds: ["core"],
        outcome: { status: "denied", reason: integrityOutcome.reason },
        effect: "none",
      };
    }
    const auditContextProjection = async (event: ContextProjectionAudit) => {
      await this.auditSafely({
        id: this.ids.auditEventId(), requestId, type: "context_projection_degraded", employeeId: userId, threadId, messageId,
        occurredAt: this.clock.now(), metadata: safeAuditMetadata("context_projection_degraded", event),
      }, "context projection audit");
    };
    const personalContext = await this.projectionBuilder.build({ userId, requestId, audit: auditContextProjection });
    const records = await this.recordsProjectionBuilder?.build({ userId, requestId, today: ownerToday }) ?? emptyRecordsProjection({ userId, requestId, now: this.clock.now() });
    let captureResult: CaptureIdeaResult | undefined;
    const observedExecutionTrace: AssistantExecutionTraceEvent[] = [];
    const markProcessUsed = (id: AssistantDiagnosticProcessId) => {
      if (!isAssistantDiagnosticProcessId(id)) throw new Error(`unknown assistant diagnostic process id: ${id}`);
      observedExecutionTrace.push({ kind: "process", processId: id });
    };
    const chatEffect: { state: AssistantChatEffectState } = { state: "none" };
    const currentChatEffectState = (): AssistantChatEffectState => chatEffect.state;
    const captureIdea = async (idea: Omit<CaptureIdeaInput, "id" | "userId" | "source">) => {
      try {
        captureResult = await this.deps.ingestionService.captureIdea({ ...idea, id: this.ids.ideaId(), userId, source });
      } catch (cause) {
        chatEffect.state = "outcome_unknown";
        throw new AssistantMutationOutcomeUnknownError({ cause });
      }
      const captured = captureResult;
      observedExecutionTrace.push({ kind: "tool", toolName: "captureIdea" });
      chatEffect.state = "business_write_committed";
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
    const documents = createOwnerDocumentReader({ userId, documentStore: this.deps.documentStore, audit: auditDocumentTool, contextBudget: this.contextBudget });
    let pendingTaskMutation: PendingTaskMutation | undefined;
    const tasks = createAssistantTaskCapabilities({
      ownerId: userId,
      tasks: this.deps.taskStore,
      mutations: this.deps.taskMutations,
      ideaToTask: this.deps.ideaToTask,
      taskId: () => (this.ids.taskId ?? randomIdGenerator.taskId!)(),
      audit: { requestId, threadId, messageId },
      onProposal: (pending) => {
        if (pendingTaskMutation) throw new Error("only one task proposal is allowed per assistant turn");
        pendingTaskMutation = pending;
        chatEffect.state = "pending_action_created";
      },
    });
    const systemContextBudget = buildAssistantSystemContextBudget(personalContext, records, this.deps.agentInstructions, renderResponsePolicy(responsePolicy), profileAndHistory, text, this.contextBudget);
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
    const agentContext = {
      personalContext,
      profileAndHistory,
      records,
      source,
      systemContext: systemContextBudget.text,
      captureIdea,
      documents,
      tasks,
      markProcessUsed,
    } satisfies AssistantAgentContext;
    let executionTrace: AssistantExecutionTrace = [];
    try {
      const run = normalizeAssistantAgentRunResult(await this.agentRunner({ userId, threadId, text }, agentContext));
      response = run.text;
      executionTrace = run.executionTrace;
    } catch (error) {
      const overflowReason = classifyProviderContextOverflow(error);
      if (!overflowReason) {
        agentError = error;
      } else if (currentChatEffectState() === "business_write_committed") {
        agentError = new AssistantContextOverflowError(overflowReason, { cause: error, durableEffectCommitted: true });
      } else if (currentChatEffectState() === "outcome_unknown") {
        agentError = new AssistantMutationOutcomeUnknownError({ cause: error });
      } else if (currentChatEffectState() === "pending_action_created") {
        response = overflowAfterPendingActionUserMessage;
      } else {
        const [reducedPersonalContext, reducedRecords] = await Promise.all([
          this.overflowProjectionBuilder.build({ userId, requestId, audit: auditContextProjection }),
          this.overflowRecordsProjectionBuilder?.build({ userId, requestId, today: ownerToday }) ?? Promise.resolve(emptyRecordsProjection({ userId, requestId, now: this.clock.now() })),
        ]);
        const reducedProfileAndHistory = reduceProfileAndHistory(profileAndHistory, this.overflowRecoveryContextBudget);
        const reduced = buildAssistantSystemContextBudget(
          reducedPersonalContext,
          reducedRecords,
          this.deps.agentInstructions,
          renderResponsePolicy(responsePolicy),
          reducedProfileAndHistory,
          text,
          this.overflowRecoveryContextBudget,
        );
        await this.auditSafely({
          id: this.ids.auditEventId(), requestId, type: "overflow_recovery", employeeId: userId, threadId, messageId,
          occurredAt: this.clock.now(), metadata: safeAuditMetadata("overflow_recovery", {
            reason: overflowReason,
            attempt: 1,
            recordsCeiling: sourceCharacterCeiling(this.overflowRecoveryContextBudget, "records"),
            historyCeiling: sourceCharacterCeiling(this.overflowRecoveryContextBudget, "history"),
            contextIndexCeiling: sourceCharacterCeiling(this.overflowRecoveryContextBudget, "context_index"),
          }),
        }, "overflow recovery audit");
        try {
          observedExecutionTrace.length = 0;
          const retryRun = normalizeAssistantAgentRunResult(await this.agentRunner({ userId, threadId, text }, {
            ...agentContext,
            personalContext: reducedPersonalContext,
            profileAndHistory: reducedProfileAndHistory,
            records: reducedRecords,
            systemContext: reduced.text,
          }));
          response = retryRun.text;
          executionTrace = retryRun.executionTrace;
        } catch (retryError) {
          const retryEffectState = currentChatEffectState();
          if (!classifyProviderContextOverflow(retryError)) {
            agentError = retryError;
          } else if (retryEffectState === "business_write_committed") {
            agentError = new AssistantContextOverflowError(overflowReason, { cause: retryError, durableEffectCommitted: true });
          } else if (retryEffectState === "outcome_unknown") {
            agentError = new AssistantMutationOutcomeUnknownError({ cause: retryError });
          } else if (retryEffectState === "pending_action_created") {
            response = overflowAfterPendingActionUserMessage;
          } else {
            agentError = new AssistantContextOverflowError(overflowReason, { cause: retryError });
          }
        }
      }
    }
    if (currentChatEffectState() === "outcome_unknown") {
      agentError = agentError instanceof AssistantMutationOutcomeUnknownError
        ? agentError
        : new AssistantMutationOutcomeUnknownError({ cause: agentError });
      response = undefined;
    }
    // Infrastructure failures must not discard owner input. File uploads are
    // also a deterministic capture gate; semantic routing of successful text
    // turns remains the agent's responsibility.
    if (currentChatEffectState() === "none" && !captureResult && !pendingTaskMutation && this.deps.ideaStore && (agentError !== undefined || source.kind === "blob")) {
      const fallback = await captureIdea({
        project: NO_PROJECT,
        type: "knowledge",
        summary: text,
        suggestedNextStep: "Уточнить проект и следующий шаг.",
        needsProjectClarification: true,
      });
      if (agentError !== undefined && !(agentError instanceof AssistantContextOverflowError)) response = fallback.response;
    }
    if (response !== undefined && !response.trim()) response = undefined;
    if (response === undefined && captureResult && !(agentError instanceof AssistantContextOverflowError)) response = captureResult.response;
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
    this.scheduleThreadCompaction({ employeeId: userId, threadId, requestId });
    const selectedProcessIds = deriveSelectedProcessIds(mergeExecutionTrace(executionTrace, observedExecutionTrace));
    return {
      messageId,
      response,
      selectedProcessIds,
      outcome: { status: "completed" },
      personalContextDocuments: personalContext.data.documents.map((document) => document.path),
      ...(pendingTaskMutation ? { pendingAction: pendingTaskAction(pendingTaskMutation) } : {}),
      effect: currentChatEffectState(),
    };
  }

  private scheduleThreadCompaction(input: { employeeId: string; threadId: string; requestId: string }): void {
    if (!this.deps.threadCompactionService) return;
    queueMicrotask(() => {
      void this.deps.threadCompactionService!.compact(input).catch((error) => {
        logAssistantOperationalError("thread compaction", error);
      });
    });
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
  const profileSection = profileAndHistory === undefined ? "" : renderRuntimeProfileProjection(profileAndHistory.profile.data);
  const threadSummarySection = profileAndHistory === undefined ? "" : renderThreadSummaryProjection(profileAndHistory.thread.data);
  const historySection = profileAndHistory === undefined ? "" : renderRecentHistoryProjection(profileAndHistory.thread.data);
  return applyContextBudget({
    userInput,
    config: contextBudget,
    sections: [
      { sourceId: "base_instructions", content: renderAssistantBaseInstructions() },
      { sourceId: "agent_manual", content: renderAssistantAgentManual(agentInstructions, responsePolicy) },
      { sourceId: "profile", content: profileSection },
      { sourceId: "context", content: renderAssistantContextProjection(personalContext) },
      { sourceId: "context_index", content: renderAssistantContextIndex(personalContext) },
      ...(records === undefined ? [] : [{ sourceId: "records" as const, content: renderAssistantRecordsProjection(records) }]),
      { sourceId: "thread_summary", content: threadSummarySection },
      { sourceId: "history", content: historySection },
    ],
  });
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

function reduceProfileAndHistory(snapshot: ChatProcSnapshot, budget: ContextBudgetConfig): ChatProcSnapshot {
  const bounded = boundRecentHistory(snapshot.thread.data.turns, {
    turns: budget.projectionLimits.historyTurns,
    characters: sourceCharacterCeiling(budget, "history"),
    fieldCharacters: budget.projectionLimits.historyTurnCharacters,
    initiallyTruncated: snapshot.thread.data.truncated,
  });
  return {
    profile: snapshot.profile,
    thread: { ...snapshot.thread, data: { ...snapshot.thread.data, ...bounded } },
  };
}

function normalizeAssistantAgentRunResult(result: AssistantAgentRunResult | string): AssistantAgentRunResult {
  return typeof result === "string" ? { text: result, executionTrace: [] } : result;
}

function mergeExecutionTrace(runnerTrace: AssistantExecutionTrace, observedTrace: AssistantExecutionTrace): AssistantExecutionTraceEvent[] {
  const merged: AssistantExecutionTraceEvent[] = [];
  const remaining = [...observedTrace];
  for (const event of runnerTrace) {
    merged.push(event);
    const duplicate = remaining.findIndex((candidate) => sameExecutionEvidence(candidate, event));
    if (duplicate >= 0) remaining.splice(duplicate, 1);
  }
  return [...merged, ...remaining];
}

function sameExecutionEvidence(left: AssistantExecutionTraceEvent, right: AssistantExecutionTraceEvent): boolean {
  return left.kind === right.kind && (left.kind === "tool" ? left.toolName === (right as typeof left).toolName : left.processId === (right as typeof left).processId);
}

const processByToolName: Readonly<Record<string, AssistantProcessId | undefined>> = {
  captureIdea: "inbox_capture",
};

export function deriveSelectedProcessIds(executionTrace: AssistantExecutionTrace): AssistantProcessId[] {
  const selected: AssistantProcessId[] = ["core"];
  const add = (id: AssistantProcessId | undefined) => {
    if (id && !selected.includes(id)) selected.push(id);
  };
  for (const event of executionTrace) {
    if (event.kind === "tool") add(processByToolName[event.toolName]);
    else if (isAssistantProcessId(event.processId) && isAssistantDiagnosticProcessId(event.processId)) add(event.processId);
  }
  return selected;
}

function emptyRecordsProjection(input: { userId: string; requestId: string; now: string }): AssistantRecordsProjection {
  return {
    schemaVersion: 1,
    path: "/proc/records",
    generatedAt: input.now,
    scope: { userId: input.userId, requestId: input.requestId },
    data: { records: [], tasks: [], truncated: false },
  };
}
