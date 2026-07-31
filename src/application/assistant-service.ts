import type { ConversationStore } from "./conversation-store.js";
import { applyContextBudget, defaultContextBudget, sourceCharacterCeiling, type ContextBudgetConfig, type ContextBudgetResult } from "./context-budget.js";
import { AssistantContextOverflowError, classifyProviderContextOverflow, createOverflowRecoveryContextBudget, overflowAfterDurableWriteAndPendingActionUserMessage, overflowAfterPendingActionUserMessage } from "./assistant-overflow-recovery.js";
import { AssistantMutationOutcomeUnknownError, mutationOutcomeUnknownWithPendingActionUserMessage, type AssistantChatEffectState } from "./assistant-mutation-outcome.js";
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
import { estimateUsageCostUsdMicros, usageMonth, type ModelTokenUsage, type UsageCostPolicy, type UsageStore } from "./usage-store.js";

export type AssistantChatInput = { userId: string; threadId: string; text: string; source?: IdeaSource; inputModality?: "text" | "voice"; responseChannel?: ResponseChannel; requiredProcessId?: AssistantDiagnosticProcessId; signal?: AbortSignal };
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
export type AssistantAgentRunResult = { text: string; executionTrace: AssistantExecutionTrace; usage?: ModelTokenUsage };
export type AssistantAgentRunner = (input: AssistantChatInput, context: AssistantAgentContext, signal?: AbortSignal) => Promise<AssistantAgentRunResult>;
type AssistantServiceRunner = (input: AssistantChatInput, context: AssistantAgentContext, signal?: AbortSignal) => Promise<AssistantAgentRunResult | string>;
export type AssistantOperationalWarning =
  | (Pick<ContextBudgetResult, "used" | "available" | "omittedSourceIds"> & { type: "context_budget_overflow" })
  | { type: "usage_soft_limit_exceeded"; userId: string; month: string; estimatedCostUsdMicros: number; softLimitUsdMicros: number };
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
    private readonly deps: { documentStore: DocumentStore; conversationStore: ConversationStore; ingestionService: Pick<IngestionService, "saveContextDocument" | "captureIdea">; requestIntegrityGuard: RequestIntegrityGuard; ideaStore?: IdeaStore; taskStore?: TaskReader; taskMutations?: Pick<TaskMutationConfirmationService, "propose">; ideaToTask?: Pick<IdeaToTaskService, "propose">; auditEventStore?: AuditEventStore; usageStore?: UsageStore; usageCostPolicy?: UsageCostPolicy; participantStore?: Pick<ProfileStore, "getParticipant"> & Partial<Pick<ProfileStore, "getProfile">>; chatProjectionBuilder?: Pick<RuntimeProjectionBuilder, "buildChatProc">; threadCompactionService?: ThreadCompactionService; clock?: Clock; idGenerator?: IdGenerator; agentInstructions?: string; contextBudget?: ContextBudgetConfig; contextPriorities?: ContextPriorityManifest; operationalLogger?: AssistantOperationalLogger; applicationTimeoutMs?: number; recoveryReserveMs?: number },
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
    const chatStartedAt = Date.now();
    const userId = assertUserId(input.userId);
    const threadId = input.threadId.trim();
    const text = input.text.trim();
    const source = input.source ?? { kind: "text", text };
    const requiredProcessId = input.requiredProcessId;
    if (requiredProcessId !== undefined && !isAssistantDiagnosticProcessId(requiredProcessId)) throw new Error(`unknown required assistant process id: ${requiredProcessId}`);
    if (!threadId) throw new Error("threadId is required");
    if (!text) throw new Error("text is required");
    const applicationSignal = createAssistantApplicationSignal(this.deps.applicationTimeoutMs, input.signal);
    throwAssistantAbortReason(applicationSignal);
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
    const chatEffect: { businessWrite: "none" | "committed" | "outcome_unknown"; pendingActionCreated: boolean } = {
      businessWrite: "none",
      pendingActionCreated: false,
    };
    const currentChatEffectState = (): AssistantChatEffectState => chatEffect.businessWrite === "outcome_unknown"
      ? "outcome_unknown"
      : chatEffect.businessWrite === "committed"
        ? "business_write_committed"
        : chatEffect.pendingActionCreated
          ? "pending_action_created"
          : "none";
    const overflowAfterEffects = (reason: ConstructorParameters<typeof AssistantContextOverflowError>[0], cause: unknown): string | Error => {
      if (chatEffect.businessWrite === "outcome_unknown") {
        return chatEffect.pendingActionCreated
          ? mutationOutcomeUnknownWithPendingActionUserMessage
          : new AssistantMutationOutcomeUnknownError({ cause });
      }
      if (chatEffect.businessWrite === "committed") {
        return chatEffect.pendingActionCreated
          ? overflowAfterDurableWriteAndPendingActionUserMessage
          : new AssistantContextOverflowError(reason, { cause, durableEffectCommitted: true });
      }
      if (chatEffect.pendingActionCreated) return overflowAfterPendingActionUserMessage;
      return new AssistantContextOverflowError(reason, { cause });
    };
    const captureIdea = async (idea: Omit<CaptureIdeaInput, "id" | "userId" | "source">) => {
      try {
        captureResult = await this.deps.ingestionService.captureIdea({ ...idea, id: this.ids.ideaId(), userId, source });
      } catch (cause) {
        chatEffect.businessWrite = "outcome_unknown";
        throw new AssistantMutationOutcomeUnknownError({ cause });
      }
      const captured = captureResult;
      observedExecutionTrace.push({ kind: "tool", toolName: "captureIdea" });
      if (chatEffect.businessWrite === "none") chatEffect.businessWrite = "committed";
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
    const taskProposalState: { persistence: "none" | "attempted" | "persisted" } = { persistence: "none" };
    const reserveTaskProposalSlot = (pending: PendingTaskMutation) => {
      throwAssistantAbortReason(applicationSignal);
      if (taskProposalState.persistence !== "none") throw new Error("only one task proposal is allowed per assistant turn");
      pendingTaskMutation = pending;
      taskProposalState.persistence = "attempted";
    };
    const tasks = createAssistantTaskCapabilities({
      ownerId: userId,
      tasks: this.deps.taskStore,
      mutations: this.deps.taskMutations,
      ideaToTask: this.deps.ideaToTask,
      taskId: () => (this.ids.taskId ?? randomIdGenerator.taskId!)(),
      audit: { requestId, threadId, messageId },
      beforePersist: reserveTaskProposalSlot,
      onProposal: () => {
        taskProposalState.persistence = "persisted";
        chatEffect.pendingActionCreated = true;
      },
    });
    const systemContextBudget = buildAssistantSystemContextBudget(personalContext, records, this.deps.agentInstructions, renderResponsePolicy(responsePolicy), profileAndHistory, text, this.contextBudget, requiredProcessId);
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
    let usage: ModelTokenUsage | undefined;
    try {
      const run = normalizeAssistantAgentRunResult(await this.agentRunner({ userId, threadId, text }, agentContext, applicationSignal));
      response = run.text;
      executionTrace = run.executionTrace;
      usage = run.usage;
    } catch (error) {
      const overflowReason = classifyProviderContextOverflow(error);
      if (!overflowReason) {
        agentError = error;
      } else if (currentChatEffectState() !== "none") {
        const recovery = overflowAfterEffects(overflowReason, error);
        if (typeof recovery === "string") response = recovery;
        else agentError = recovery;
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
          requiredProcessId,
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
          throwAssistantAbortReason(applicationSignal);
          const retryRun = normalizeAssistantAgentRunResult(await this.agentRunner({ userId, threadId, text }, {
            ...agentContext,
            personalContext: reducedPersonalContext,
            profileAndHistory: reducedProfileAndHistory,
            records: reducedRecords,
            systemContext: reduced.text,
          }, applicationSignal));
          response = retryRun.text;
          executionTrace = retryRun.executionTrace;
          usage = retryRun.usage;
        } catch (retryError) {
          const retryEffectState = currentChatEffectState();
          if (!classifyProviderContextOverflow(retryError)) {
            agentError = retryError;
          } else if (retryEffectState !== "none") {
            const recovery = overflowAfterEffects(overflowReason, retryError);
            if (typeof recovery === "string") response = recovery;
            else agentError = recovery;
          } else {
            agentError = new AssistantContextOverflowError(overflowReason, { cause: retryError });
          }
        }
      }
    }
    if (taskProposalState.persistence === "attempted") {
      response = uncertainTaskProposalResponse(chatEffect.businessWrite);
      chatEffect.businessWrite = "outcome_unknown";
      agentError = undefined;
    } else if (taskProposalState.persistence === "persisted" && agentError !== undefined) {
      agentError = undefined;
      response = downstreamErrorAfterTaskProposal(chatEffect.businessWrite);
    }
    if (chatEffect.businessWrite === "outcome_unknown") {
      if (chatEffect.pendingActionCreated) {
        agentError = undefined;
        response = mutationOutcomeUnknownWithPendingActionUserMessage;
      } else if (taskProposalState.persistence === "none") {
        agentError = agentError instanceof AssistantMutationOutcomeUnknownError
          ? agentError
          : new AssistantMutationOutcomeUnknownError({ cause: agentError });
        response = undefined;
      }
    }
    if (applicationSignal.aborted && taskProposalState.persistence === "none" && currentChatEffectState() === "none") {
      throwAssistantAbortReason(applicationSignal);
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
    const usageWarning = usage ? await this.recordUsageSafely({ userId, requestId, threadId, messageId, usage }) : undefined;
    if (usageWarning) response = appendUsageSoftLimitWarning(response);
    try {
      const appendTurn = this.deps.conversationStore.appendTurn({
        messageId,
        // The existing application history store uses employeeId as its neutral
        // owner key. AssistantService maps its trusted userId only at this seam.
        employeeId: userId,
        threadId,
        userText: text,
        agentResponse: response,
        timestamp: this.clock.now(),
      });
      await boundedRecovery(appendTurn, computeRecoveryRemainingMs(chatStartedAt, this.deps.applicationTimeoutMs, this.deps.recoveryReserveMs));
    } catch (error) {
      if (taskProposalState.persistence === "none" && !isRecoveryTimeoutError(error)) throw error;
      logAssistantOperationalError("conversation history persistence after task proposal", error);
    }
    await this.auditSafely({
      id: this.ids.auditEventId(), requestId, type: "chat_response_generated", employeeId: userId, threadId, messageId,
      occurredAt: this.clock.now(), metadata: safeAuditMetadata("chat_response_generated", {}),
    }, "chat response audit");
    this.scheduleThreadCompaction({ employeeId: userId, threadId, requestId });
    const selectedProcessIds = deriveSelectedProcessIds(mergeExecutionTrace(executionTrace, [
      ...(requiredProcessId ? [{ kind: "process" as const, processId: requiredProcessId }] : []),
      ...observedExecutionTrace,
    ]));
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

  private async recordUsageSafely(input: { userId: string; requestId: string; threadId: string; messageId: string; usage: ModelTokenUsage }): Promise<boolean> {
    const store = this.deps.usageStore;
    const policy = this.deps.usageCostPolicy;
    if (!store || !policy) return false;
    const occurredAt = this.clock.now();
    try {
      const monthly = await store.record({
        id: (this.ids.usageId ?? randomIdGenerator.usageId!)(),
        userId: input.userId,
        requestId: input.requestId,
        month: usageMonth(occurredAt),
        ...input.usage,
        estimatedCostUsdMicros: estimateUsageCostUsdMicros(input.usage, policy),
        occurredAt,
      });
      if (monthly.estimatedCostUsdMicros <= policy.monthlySoftLimitUsdMicros) return false;
      await this.auditSafely({
        id: this.ids.auditEventId(), requestId: input.requestId, type: "usage_soft_limit_exceeded", employeeId: input.userId,
        threadId: input.threadId, messageId: input.messageId, occurredAt,
        metadata: safeAuditMetadata("usage_soft_limit_exceeded", {
          month: monthly.month,
          inputTokens: monthly.inputTokens,
          outputTokens: monthly.outputTokens,
          totalTokens: monthly.totalTokens,
          estimatedCostUsdMicros: monthly.estimatedCostUsdMicros,
          softLimitUsdMicros: policy.monthlySoftLimitUsdMicros,
        }),
      }, "usage soft-limit audit");
      this.warnOperationally({
        type: "usage_soft_limit_exceeded",
        userId: input.userId,
        month: monthly.month,
        estimatedCostUsdMicros: monthly.estimatedCostUsdMicros,
        softLimitUsdMicros: policy.monthlySoftLimitUsdMicros,
      });
      return true;
    } catch (error) {
      logAssistantOperationalError("usage persistence", error);
      return false;
    }
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
  requiredProcessId?: AssistantDiagnosticProcessId,
): string {
  return buildAssistantSystemContextBudget(personalContext, records, agentInstructions, responsePolicy, profileAndHistory, userInput, contextBudget, requiredProcessId).text;
}

export function buildAssistantSystemContextBudget(
  personalContext: AssistantContextProjection,
  records?: AssistantRecordsProjection,
  agentInstructions = loadAssistantAgentInstructions(),
  responsePolicy?: string,
  profileAndHistory?: ChatProcSnapshot,
  userInput = "",
  contextBudget: ContextBudgetConfig = defaultContextBudget,
  requiredProcessId?: AssistantDiagnosticProcessId,
): ContextBudgetResult {
  const profileSection = profileAndHistory === undefined ? "" : renderRuntimeProfileProjection(profileAndHistory.profile.data);
  const threadSummarySection = profileAndHistory === undefined ? "" : renderThreadSummaryProjection(profileAndHistory.thread.data);
  const historySection = profileAndHistory === undefined ? "" : renderRecentHistoryProjection(profileAndHistory.thread.data);
  return applyContextBudget({
    userInput,
    config: contextBudget,
    sections: [
      { sourceId: "base_instructions", content: renderAssistantBaseInstructions(requiredProcessId) },
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
const uncertainTaskProposalUserMessage =
  "Не удалось подтвердить, сохранено ли предложение задачи. Попробуйте подтвердить или отклонить его: если сохранение не состоялось, действие безопасно вернёт, что предложение не найдено. Не создавайте предложение повторно до проверки.";
const uncertainTaskProposalAfterWriteUserMessage =
  "Изменение сохранено, но не удалось подтвердить, сохранено ли предложение задачи. Попробуйте подтвердить или отклонить его: если сохранение предложения не состоялось, действие безопасно вернёт, что оно не найдено. Не создавайте предложение повторно до проверки.";
const uncertainTaskProposalAndWriteUserMessage =
  "Не удалось подтвердить результаты изменения и сохранения предложения задачи. Проверьте актуальное состояние, затем попробуйте подтвердить или отклонить предложение: если оно не сохранилось, действие безопасно вернёт, что предложение не найдено. Не повторяйте операции до проверки.";
const downstreamTaskProposalUserMessage =
  "Не удалось сформировать итоговый ответ, но предложение задачи сохранено и готово к подтверждению или отклонению.";
const downstreamWriteAndTaskProposalUserMessage =
  "Не удалось сформировать итоговый ответ. Изменение уже сохранено; предложение задачи готово к подтверждению или отклонению. Повторно отправлять запрос не нужно.";

function uncertainTaskProposalResponse(businessWrite: "none" | "committed" | "outcome_unknown"): string {
  if (businessWrite === "outcome_unknown") return uncertainTaskProposalAndWriteUserMessage;
  return businessWrite === "committed" ? uncertainTaskProposalAfterWriteUserMessage : uncertainTaskProposalUserMessage;
}

function downstreamErrorAfterTaskProposal(businessWrite: "none" | "committed" | "outcome_unknown"): string {
  if (businessWrite === "outcome_unknown") return mutationOutcomeUnknownWithPendingActionUserMessage;
  return businessWrite === "committed" ? downstreamWriteAndTaskProposalUserMessage : downstreamTaskProposalUserMessage;
}

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

function createAssistantApplicationSignal(timeoutMs: number | undefined, parent?: AbortSignal): AbortSignal {
  if (timeoutMs === undefined) return parent ?? new AbortController().signal;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("application timeout must be a positive safe integer");
  const deadline = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, deadline]) : deadline;
}

function throwAssistantAbortReason(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new DOMException("The operation was aborted.", "AbortError");
}

function normalizeAssistantAgentRunResult(result: AssistantAgentRunResult | string): AssistantAgentRunResult {
  return typeof result === "string" ? { text: result, executionTrace: [] } : result;
}

const usageSoftLimitUserWarning = "⚠️ Мягкий месячный лимит использования превышен. Работа продолжается; оператор уже уведомлён.";

function appendUsageSoftLimitWarning(response: string): string {
  return `${response.trimEnd()}\n\n${usageSoftLimitUserWarning}`;
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

// ---------------------------------------------------------------------------
// Recovery-bounded post-agent helpers
// ---------------------------------------------------------------------------

class RecoveryTimeoutError extends Error {
  constructor() { super("Post-agent recovery budget exhausted."); this.name = "RecoveryTimeoutError"; }
}

export function isRecoveryTimeoutError(error: unknown): error is RecoveryTimeoutError {
  return error instanceof RecoveryTimeoutError;
}

/**
 * Compute remaining recovery milliseconds. Returns `undefined` when both
 * `applicationTimeoutMs` and `recoveryReserveMs` are unset (no bounding).
 */
function computeRecoveryRemainingMs(chatStartedAt: number, applicationTimeoutMs: number | undefined, recoveryReserveMs: number | undefined): number | undefined {
  if (applicationTimeoutMs === undefined || recoveryReserveMs === undefined) return undefined;
  const deadline = chatStartedAt + applicationTimeoutMs + recoveryReserveMs;
  return Math.max(0, deadline - Date.now());
}

/**
 * Race `task` against an optional recovery timeout. When `remainingMs` is
 * `undefined` the task runs unbounded (backwards-compatible default). When the
 * budget is exhausted, throw {@link RecoveryTimeoutError} so the caller can
 * decide whether to degrade or propagate.
 */
async function boundedRecovery<T>(task: Promise<T>, remainingMs: number | undefined): Promise<T> {
  if (remainingMs === undefined) return task;
  if (remainingMs <= 0) throw new RecoveryTimeoutError();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new RecoveryTimeoutError()), remainingMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
