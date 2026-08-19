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
import { pendingIdeaDeletionAction, type IdeaDeletionService, type PendingIdeaDeletion, type PendingIdeaDeletionAction } from "./idea-deletion.js";
import { safeAuditMetadata, type AuditEventStore } from "./audit-event-store.js";
import { loadAssistantAgentInstructions } from "./assistant-manual-loader.js";
import { PersistenceError, PersistenceOutcomeUnknownError } from "./persistence-error.js";
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
import { createAssistantTaskCapabilities, type AssistantTaskCapabilities, type AssistantTaskCapabilityCallbacks } from "./assistant-task-capabilities.js";
import { renderAssistantAgentManual, renderAssistantBaseInstructions } from "./assistant-static-context.js";
import { calendarDateInIanaTimezone } from "../shared/iana-timezone.js";
import { assistantToolProcessOwners, isAssistantDiagnosticProcessId, isAssistantProcessId, type AssistantDiagnosticProcessId, type AssistantProcessId } from "../domain/assistant-process.js";
import type { ModelTokenUsage, UsageCostPolicy, UsageStore } from "./usage-store.js";
import { createUsageRecorder, type UsageOperationalWarning, type UsageRecorder } from "./usage-recorder.js";
import {
  AssistantScheduleKindChangeError,
  AssistantScheduleNotFoundError,
  AssistantScheduleProcessChangeError,
  UnsupportedAssistantScheduleProcessError,
  type OwnerScheduleCapabilities,
  type ScheduleManagementService,
} from "./schedule-management-service.js";
import { createAssistantContextDocumentCapabilities, type AssistantContextDocumentCapabilities } from "./assistant-context-document-capabilities.js";
import type { ContextDocumentService, PendingContextDocumentMutationReceipt } from "./context-document-service.js";
import { ProjectLabelService, type AssistantProjectListResult, type ProjectLabelCollectCache } from "./project-labels.js";
import type { AppendIdeaResult, IdeaAppendService } from "./idea-append.js";
import type { CollectActivityInput } from "../contracts/minutka-activity.js";
import {
  researchTraceError,
  researchTraceSchemaVersion,
  sanitizeResearchTrace,
  type ResearchTraceAttempt,
  type ResearchTraceStore,
} from "./research-trace-store.js";

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
  /** Owner-bound note creation and proposal-only Markdown mutations. */
  contextDocuments: AssistantContextDocumentCapabilities;
  /** Owner-bound task reads, level-0 writes with undo, and level-1 cancellation proposals. */
  tasks: AssistantTaskCapabilities;
  /** Owner-bound idea search, level-0 append, confirmable deletion proposal, and short-window undo. */
  ideas: {
    search(input: Parameters<IdeaDeletionService["search"]>[1]): ReturnType<IdeaDeletionService["search"]>;
    append(input: { ideaId: string; expectedRevision: number; text: string }): Promise<AppendIdeaResult>;
    propose(input: { ideaId: string; expectedRevision: number; reason?: string }): ReturnType<IdeaDeletionService["propose"]>;
    undo(input: { ideaId?: string; expectedRevision?: number }): ReturnType<IdeaDeletionService["undo"]>;
  };
  /** Owner-bound project-label read model across ideas and tasks. */
  projects: {
    list(input?: { limit?: number }): Promise<AssistantProjectListResult>;
  };
  /** Owner-bound daily schedule reads and reversible writes. */
  schedules: OwnerScheduleCapabilities;
  /** Authenticated employee and tenant-bound structured activity write. */
  collectActivity(activity: CollectActivityInput): Promise<{ activityId: string }>;
  /** Request-scoped diagnostic evidence only; it grants no capability or authority. */
  markProcessUsed(id: AssistantDiagnosticProcessId): void;
};
export type AssistantExecutionTraceEvent =
  | { kind: "tool"; toolName: string }
  | { kind: "process"; processId: string };
export type AssistantExecutionTrace = readonly AssistantExecutionTraceEvent[];
export type AssistantAgentRunTrace = {
  model: string;
  modelSteps: unknown[];
  toolCalls: unknown[];
  toolResults: unknown[];
};
export type AssistantAgentRunResult = { text: string; executionTrace: AssistantExecutionTrace; usage?: ModelTokenUsage; trace?: AssistantAgentRunTrace };
export type AssistantAgentRunner = (input: AssistantChatInput, context: AssistantAgentContext, signal?: AbortSignal) => Promise<AssistantAgentRunResult>;
type AssistantServiceRunner = (input: AssistantChatInput, context: AssistantAgentContext, signal?: AbortSignal) => Promise<AssistantAgentRunResult | string>;
export type AssistantOperationalWarning =
  | (Pick<ContextBudgetResult, "used" | "available" | "omittedSourceIds"> & { type: "context_budget_overflow" })
  | { type: "research_trace_missing"; requestId: string; messageId: string; status: "completed" | "failed"; reason: string }
  | UsageOperationalWarning;
export type AssistantOperationalLogger = (warning: AssistantOperationalWarning) => void;
export type AssistantChatOutcome =
  | { status: "completed" }
  | { status: "denied"; reason: RequestIntegrityDenialReason };
export type AssistantPendingAction = PendingTaskAction | PendingIdeaDeletionAction | PendingContextDocumentMutationReceipt;
export const maximumPendingActionsPerTurn = 5;

export type AssistantChatResult = {
  messageId: string;
  response: string;
  selectedProcessIds: AssistantProcessId[];
  /** Internal typed outcome for application/audit consumers; transports remain backward-compatible. */
  outcome: AssistantChatOutcome;
  personalContextDocuments?: string[];
  pendingActions: AssistantPendingAction[];
  /** Explicit recovery state: proposals are durable but are not business mutations. */
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
  private readonly usage: UsageRecorder;
  private readonly projectLabels: ProjectLabelService;

  constructor(
    private readonly agentRunner: AssistantServiceRunner,
    private readonly deps: { documentStore: DocumentStore; conversationStore: ConversationStore; ingestionService: Pick<IngestionService, "saveContextDocument" | "captureIdea">; requestIntegrityGuard: RequestIntegrityGuard; ideaStore?: IdeaStore; ideaAppends?: Pick<IdeaAppendService, "append">; ideaDeletions?: Pick<IdeaDeletionService, "search" | "propose" | "undo">; contextDocuments?: Pick<ContextDocumentService, "createNote" | "proposeUpdate" | "proposeMove" | "proposeDelete">; scheduleManagement?: Pick<ScheduleManagementService, "listSchedules" | "saveDailySchedule" | "disableSchedule">; collectActivity?: (input: { employeeId: string; subjectKey: string; sourceMessageId: string; companyId: string; groupId: string; roleId: string; timezone: string; activity: CollectActivityInput }) => Promise<{ activityId: string }>; projectLabels?: ProjectLabelService; taskStore?: TaskReader; taskMutations?: Pick<TaskMutationConfirmationService, "propose"> & Partial<Pick<TaskMutationConfirmationService, "autoApply" | "undo">>; ideaToTask?: Pick<IdeaToTaskService, "propose">; auditEventStore?: AuditEventStore; usageStore?: UsageStore; usageCostPolicy?: UsageCostPolicy; researchTraceStore?: ResearchTraceStore; researchTraceVersions?: { promptVersion: string; processVersion: string; taxonomyVersion: string; model: string }; participantStore?: Pick<ProfileStore, "getParticipant"> & Partial<Pick<ProfileStore, "getProfile">>; chatProjectionBuilder?: Pick<RuntimeProjectionBuilder, "buildChatProc">; threadCompactionService?: Pick<ThreadCompactionService, "compact">; clock?: Clock; idGenerator?: IdGenerator; agentInstructions?: string; contextBudget?: ContextBudgetConfig; contextPriorities?: ContextPriorityManifest; operationalLogger?: AssistantOperationalLogger; applicationTimeoutMs?: number; recoveryReserveMs?: number },
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
    // The recorder is stateless, so every service that spends tokens builds its
    // own; the soft-limit crossing is derived from the durable monthly total.
    this.projectLabels = deps.projectLabels ?? new ProjectLabelService(deps.ideaStore, deps.taskStore);
    this.usage = createUsageRecorder({
      usageStore: deps.usageStore,
      usageCostPolicy: deps.usageCostPolicy,
      auditEventStore: deps.auditEventStore,
      clock: this.clock,
      idGenerator: this.ids,
      operationalLogger: (warning) => this.warnOperationally(warning),
    });
  }

  private async saveResearchTraceSafely(input: Parameters<ResearchTraceStore["append"]>[0]): Promise<void> {
    if (!this.deps.researchTraceStore) return;
    try {
      await this.deps.researchTraceStore.append(sanitizeResearchTrace(input));
    } catch (error) {
      const reason = error instanceof Error ? error.name : "UnknownError";
      this.warnOperationally({
        type: "research_trace_missing",
        requestId: input.requestId,
        messageId: input.messageId,
        status: input.status,
        reason,
      });
      await this.auditSafely({
        id: this.ids.auditEventId(),
        requestId: input.requestId,
        type: "trace_missing",
        employeeId: undefined,
        messageId: input.messageId,
        occurredAt: this.clock.now(),
        metadata: safeAuditMetadata("trace_missing", { reason, status: input.status }),
      }, "trace missing audit");
    }
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
    const participant = await this.deps.participantStore?.getParticipant(userId);
    if (this.deps.participantStore && !participant) throw new PersistenceError("participant_not_found");
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
    const traceVersions = this.deps.researchTraceVersions;
    const saveDeniedOrFailedTrace = async (input: { status: "completed" | "failed"; context: string; output?: string; error?: unknown; usage?: ModelTokenUsage; processIds?: string[] }) => {
      if (!participant || !this.deps.researchTraceStore || !traceVersions) return;
      const completedAt = this.clock.now();
      await this.saveResearchTraceSafely({
        schemaVersion: researchTraceSchemaVersion,
        traceId: (this.ids.traceId ?? randomIdGenerator.traceId!)(),
        requestId,
        messageId,
        companyId: participant.companyId,
        groupId: participant.groupId,
        subjectKey: participant.subjectKey,
        processIds: input.processIds ?? ["core"],
        ...traceVersions,
        samplingRate: 1,
        input: { text, modality: inputModality },
        attempts: [researchTraceAttempt(1, input.context, undefined, input.error)],
        ...(input.output === undefined ? {} : { output: input.output }),
        ...(input.usage === undefined ? {} : { usage: input.usage }),
        startedAt: new Date(chatStartedAt).toISOString(),
        completedAt,
        latencyMs: Math.max(0, Date.parse(completedAt) - chatStartedAt),
        status: input.status,
        ...(input.error === undefined ? {} : { error: researchTraceError(input.error) }),
      });
    };
    let integrityOutcome: Awaited<ReturnType<RequestIntegrityGuard>>;
    try {
      integrityOutcome = await this.deps.requestIntegrityGuard({ userId, text });
    } catch (error) {
      await saveDeniedOrFailedTrace({ status: "failed", context: "request_integrity_guard", error });
      throw error;
    }
    // The guard runs on every turn and is billed whatever it decides, so its
    // tokens are counted before the turn can take any early exit.
    if (integrityOutcome.usage) {
      await this.usage.record({
        userId, requestId, source: "guard", threadId, messageId, usage: integrityOutcome.usage,
      });
    }
    if (integrityOutcome.status === "denied") {
      const response = requestIntegrityDenialResponse;
      await this.deps.conversationStore.appendTurn({
        messageId,
        employeeId: userId,
        subjectKey: participant?.subjectKey ?? userId,
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
      await saveDeniedOrFailedTrace({
        status: "completed",
        context: "request_integrity_guard",
        output: response,
        usage: integrityOutcome.usage,
        processIds: ["core"],
      });
      this.scheduleThreadCompaction({ employeeId: userId, threadId, requestId });
      return {
        messageId,
        response,
        selectedProcessIds: ["core"],
        outcome: { status: "denied", reason: integrityOutcome.reason },
        pendingActions: [],
        effect: "none",
      };
    }
    const auditContextProjection = async (event: ContextProjectionAudit) => {
      await this.auditSafely({
        id: this.ids.auditEventId(), requestId, type: "context_projection_degraded", employeeId: userId, threadId, messageId,
        occurredAt: this.clock.now(), metadata: safeAuditMetadata("context_projection_degraded", event),
      }, "context projection audit");
    };
    let personalContext: AssistantContextProjection;
    let records: AssistantRecordsProjection;
    try {
      personalContext = await this.projectionBuilder.build({ userId, requestId, audit: auditContextProjection });
      records = await this.recordsProjectionBuilder?.build({ userId, requestId, today: ownerToday }) ?? emptyRecordsProjection({ userId, requestId, now: this.clock.now() });
    } catch (error) {
      await saveDeniedOrFailedTrace({ status: "failed", context: "context_projection", error });
      throw error;
    }
    type PendingActionSlot =
      | { sequence: number; kind: "task"; pending: PendingTaskMutation; title?: string; persistence: "attempted" | "persisted" }
      | { sequence: number; kind: "idea"; record: PendingIdeaDeletion; idea: Parameters<typeof pendingIdeaDeletionAction>[1] }
      | { sequence: number; kind: "context"; confirmation: PendingContextDocumentMutationReceipt };
    const pendingActionSlots: PendingActionSlot[] = [];
    let pendingActionSequence = 0;
    let reservedPendingActionSlots = 0;
    let pendingActionLimitReached = false;
    const pendingActionCount = () => pendingActionSlots.length + reservedPendingActionSlots;
    const reservePendingActionSlot = () => {
      throwAssistantAbortReason(applicationSignal);
      if (pendingActionSlots.some((slot) => slot.kind === "task" && slot.persistence === "attempted")) {
        throw new Error("a task proposal with unknown persistence keeps its pending action slot reserved");
      }
      if (pendingActionCount() >= maximumPendingActionsPerTurn) {
        pendingActionLimitReached = true;
        throw new PendingActionGroupLimitError();
      }
      reservedPendingActionSlots += 1;
    };
    const releasePendingActionSlot = () => { reservedPendingActionSlots = Math.max(0, reservedPendingActionSlots - 1); };
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
    const projectLabelCache: ProjectLabelCollectCache = {};
    const invalidateProjectLabels = () => { projectLabelCache.collected = undefined; };
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
      const requestedProject = idea.project.trim();
      const project = idea.needsProjectClarification || !requestedProject || requestedProject === NO_PROJECT
        ? NO_PROJECT
        : await this.projectLabels.canonicalize(userId, requestedProject, projectLabelCache);
      try {
        captureResult = await this.deps.ingestionService.captureIdea({ ...idea, project, id: this.ids.ideaId(), userId, source });
      } catch (cause) {
        chatEffect.businessWrite = "outcome_unknown";
        throw new AssistantMutationOutcomeUnknownError({ cause });
      }
      const captured = captureResult;
      invalidateProjectLabels();
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
      observedExecutionTrace.push({ kind: "process", processId: "knowledge_lookup" });
      await this.auditSafely({
        id: this.ids.auditEventId(), requestId, type: "document_tool_used", employeeId: userId, threadId, messageId,
        occurredAt: this.clock.now(), metadata: safeAuditMetadata("document_tool_used", event),
      }, "document tool audit");
    };
    const documents = createOwnerDocumentReader({ userId, documentStore: this.deps.documentStore, audit: auditDocumentTool, contextBudget: this.contextBudget });
    const reserveTaskProposalSlot: AssistantTaskCapabilityCallbacks["beforePersist"] = (pending) => {
      reservePendingActionSlot();
      releasePendingActionSlot();
      pendingActionSlots.push({ sequence: pendingActionSequence++, kind: "task", pending, persistence: "attempted" });
    };
    const ideas = {
      search: (input: { query?: string; limit?: number }) => {
        if (!this.deps.ideaDeletions) throw new Error("idea search is not configured");
        return this.deps.ideaDeletions.search(userId, input);
      },
      append: async (input: { ideaId: string; expectedRevision: number; text: string }) => {
        if (!this.deps.ideaAppends) throw new Error("idea append is not configured");
        const result = await this.deps.ideaAppends.append(userId, input, {
          requestId,
          threadId,
          messageId,
        });
        observedExecutionTrace.push({ kind: "tool", toolName: "appendIdea" });
        if (result.status === "applied" && chatEffect.businessWrite === "none") chatEffect.businessWrite = "committed";
        return result;
      },
      propose: async (input: { ideaId: string; expectedRevision: number; reason?: string }) => {
        if (!this.deps.ideaDeletions) throw new Error("idea deletion is not configured");
        reservePendingActionSlot();
        let result: Awaited<ReturnType<IdeaDeletionService["propose"]>>;
        try {
          result = await this.deps.ideaDeletions.propose(userId, input, {
            audit: { requestId, threadId, messageId },
          });
        } catch (error) {
          releasePendingActionSlot();
          throw error;
        }
        releasePendingActionSlot();
        if (result.status === "needs_confirmation") {
          pendingActionSlots.push({ sequence: pendingActionSequence++, kind: "idea", record: result.confirmation, idea: result.idea });
          chatEffect.pendingActionCreated = true;
        }
        return result;
      },
      undo: async (input: { ideaId?: string; expectedRevision?: number }) => {
        if (!this.deps.ideaDeletions) throw new Error("idea deletion is not configured");
        const result = await this.deps.ideaDeletions.undo(userId, input, { requestId, threadId, messageId });
        if (result.outcome === "restored") chatEffect.businessWrite = "committed";
        observedExecutionTrace.push({ kind: "tool", toolName: "undoIdeaDeletion" });
        return result;
      },
    };
    const contextDocuments = createAssistantContextDocumentCapabilities({
      ownerId: userId,
      service: this.deps.contextDocuments,
      audit: { requestId, threadId, messageId },
      reserveProposal() { reservePendingActionSlot(); },
      releaseProposal() { releasePendingActionSlot(); },
      onProposal(confirmation) {
        releasePendingActionSlot();
        pendingActionSlots.push({ sequence: pendingActionSequence++, kind: "context", confirmation });
        chatEffect.pendingActionCreated = true;
      },
      onCreate(outcome) {
        observedExecutionTrace.push({ kind: "tool", toolName: "createContextNote" });
        if (outcome.outcome === "created" && chatEffect.businessWrite === "none") chatEffect.businessWrite = "committed";
      },
    });
    const schedules: OwnerScheduleCapabilities = {
      listSchedules: () => {
        if (!this.deps.scheduleManagement) throw new Error("schedule management is not configured");
        return this.deps.scheduleManagement.listSchedules(userId);
      },
      saveDailySchedule: async (input) => {
        if (!this.deps.scheduleManagement) throw new Error("schedule management is not configured");
        try {
          const schedule = await this.deps.scheduleManagement.saveDailySchedule(userId, input);
          if (chatEffect.businessWrite === "none") chatEffect.businessWrite = "committed";
          return schedule;
        } catch (cause) {
          if (cause instanceof UnsupportedAssistantScheduleProcessError
            || cause instanceof AssistantScheduleNotFoundError
            || cause instanceof AssistantScheduleKindChangeError
            || cause instanceof AssistantScheduleProcessChangeError) throw cause;
          chatEffect.businessWrite = "outcome_unknown";
          throw new AssistantMutationOutcomeUnknownError({ cause });
        }
      },
      disableSchedule: async (scheduleId) => {
        if (!this.deps.scheduleManagement) throw new Error("schedule management is not configured");
        try {
          const schedule = await this.deps.scheduleManagement.disableSchedule(userId, scheduleId);
          if (schedule && chatEffect.businessWrite === "none") chatEffect.businessWrite = "committed";
          return schedule;
        } catch (cause) {
          chatEffect.businessWrite = "outcome_unknown";
          throw new AssistantMutationOutcomeUnknownError({ cause });
        }
      },
    };
    const projects = {
      list: (projectInput: { limit?: number } = {}) => this.projectLabels.list(userId, projectInput, projectLabelCache),
    };
    // The tool commits inside the agent loop, so its `sourceMessageId` names the
    // turn that is still running. When the turn later fails before the
    // conversation append, the activity stays — the corpus keeps what the
    // employee reported — and the evidence link resolves to no message.
    const collectActivity = async (activity: CollectActivityInput) => {
      if (!this.deps.collectActivity) throw new Error("activity collection is not configured");
      const participant = await this.deps.participantStore?.getParticipant(userId);
      const companyId = participant?.companyId;
      const groupId = participant?.groupId;
      const subjectKey = participant?.subjectKey;
      const roleId = participant?.roleId;
      const timezone = profile?.timezone;
      if (!companyId || !groupId || !subjectKey || !roleId || !timezone) throw new PersistenceError("profile_not_found");
      try {
        const result = await this.deps.collectActivity({ employeeId: userId, subjectKey, sourceMessageId: messageId, companyId, groupId, roleId, timezone, activity });
        observedExecutionTrace.push({ kind: "tool", toolName: "collectActivity" });
        if (chatEffect.businessWrite === "none") chatEffect.businessWrite = "committed";
        return result;
      } catch (cause) {
        if (!(cause instanceof PersistenceOutcomeUnknownError)) throw cause;
        chatEffect.businessWrite = "outcome_unknown";
        throw new AssistantMutationOutcomeUnknownError({ cause });
      }
    };
    const tasks = createAssistantTaskCapabilities({
      ownerId: userId,
      tasks: this.deps.taskStore,
      mutations: this.deps.taskMutations,
      ideaToTask: this.deps.ideaToTask,
      taskId: () => (this.ids.taskId ?? randomIdGenerator.taskId!)(),
      canonicalizeProject: (project) => this.projectLabels.canonicalize(userId, project, projectLabelCache),
      audit: { requestId, threadId, messageId },
      beforePersist: reserveTaskProposalSlot,
      onProposal: ((pending, taskTitle) => {
        const slot = pendingActionSlots.find((candidate) => candidate.kind === "task" && candidate.pending.confirmationId === pending.confirmationId);
        if (!slot || slot.kind !== "task") throw new Error("reserved task proposal slot is missing");
        slot.title = taskTitle;
        slot.persistence = "persisted";
        chatEffect.pendingActionCreated = true;
      }) satisfies AssistantTaskCapabilityCallbacks["onProposal"],
      onResolved: ((result, pending) => {
        const index = pendingActionSlots.findIndex((candidate) => candidate.kind === "task" && candidate.pending.confirmationId === pending.confirmationId);
        if (index >= 0) pendingActionSlots.splice(index, 1);
        chatEffect.pendingActionCreated = pendingActionSlots.length > 0;
        if (result.status === "applied") {
          invalidateProjectLabels();
          if (chatEffect.businessWrite === "none") chatEffect.businessWrite = "committed";
        }
      }) satisfies AssistantTaskCapabilityCallbacks["onResolved"],
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
      contextDocuments,
      tasks,
      ideas,
      projects,
      schedules,
      collectActivity,
      markProcessUsed,
    } satisfies AssistantAgentContext;
    let executionTrace: AssistantExecutionTrace = [];
    let usage: ModelTokenUsage | undefined;
    let usageContextSourceCharacters = systemContextBudget.contextSourceCharacters;
    const traceAttempts: ResearchTraceAttempt[] = [];
    try {
      const run = normalizeAssistantAgentRunResult(await this.agentRunner({ userId, threadId, text }, agentContext, applicationSignal));
      response = run.text;
      executionTrace = run.executionTrace;
      usage = run.usage;
      traceAttempts.push(researchTraceAttempt(1, systemContextBudget.text, run.trace));
    } catch (error) {
      const overflowReason = classifyProviderContextOverflow(error);
      if (!overflowReason) {
        traceAttempts.push(researchTraceAttempt(1, systemContextBudget.text, undefined, error));
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
          if (traceAttempts.length === 0) traceAttempts.push(researchTraceAttempt(1, systemContextBudget.text, undefined, error));
          response = retryRun.text;
          executionTrace = retryRun.executionTrace;
          usage = retryRun.usage;
          usageContextSourceCharacters = reduced.contextSourceCharacters;
          traceAttempts.push(researchTraceAttempt(2, reduced.text, retryRun.trace));
        } catch (retryError) {
          const retryEffectState = currentChatEffectState();
          traceAttempts.push(researchTraceAttempt(2, reduced.text, undefined, retryError));
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
    const attemptedTaskProposal = pendingActionSlots.some((slot) => slot.kind === "task" && slot.persistence === "attempted");
    const persistedTaskProposal = pendingActionSlots.some((slot) => slot.kind === "task" && slot.persistence === "persisted");
    if (attemptedTaskProposal) {
      response = uncertainTaskProposalResponse(chatEffect.businessWrite);
      chatEffect.businessWrite = "outcome_unknown";
      chatEffect.pendingActionCreated = true;
      agentError = undefined;
    } else if (agentError instanceof PendingActionGroupLimitError) {
      response = pendingActionGroupLimitUserMessage;
      agentError = undefined;
    } else if (agentError !== undefined && pendingActionSlots.length > 0) {
      agentError = undefined;
      response = persistedTaskProposal
        ? downstreamErrorAfterTaskProposal(chatEffect.businessWrite)
        : "Не удалось сформировать итоговый ответ, но предложения сохранены и готовы к подтверждению или отклонению.";
    }
    if (chatEffect.businessWrite === "outcome_unknown") {
      if (chatEffect.pendingActionCreated) {
        agentError = undefined;
        if (!attemptedTaskProposal) response = mutationOutcomeUnknownWithPendingActionUserMessage;
      } else if (!attemptedTaskProposal && !persistedTaskProposal) {
        agentError = agentError instanceof AssistantMutationOutcomeUnknownError
          ? agentError
          : new AssistantMutationOutcomeUnknownError({ cause: agentError });
        response = undefined;
      }
    }
    if (applicationSignal.aborted && !attemptedTaskProposal && !persistedTaskProposal && currentChatEffectState() === "none") {
      throwAssistantAbortReason(applicationSignal);
    }
    // An empty answer is the same as no answer.
    //
    // Nothing is captured on the agent's behalf behind this point. `inbox_capture`
    // is a disabled process in «Минутка», so a turn that wrote nothing must read
    // as the loss it is: a silent turn answers plainly and keeps the employee
    // message in private conversation history, and a failed turn surfaces its
    // error. Neither is reported as a committed idea.
    if (response !== undefined && !response.trim()) response = undefined;
    if (response === undefined && captureResult && !(agentError instanceof AssistantContextOverflowError)) response = captureResult.response;
    if (response !== undefined && pendingActionLimitReached && !response.includes(pendingActionGroupLimitUserMessage)) {
      response = `${response.trimEnd()}\n\n${pendingActionGroupLimitUserMessage}`;
    }
    if (agentError !== undefined && response === undefined) {
      if (participant && this.deps.researchTraceStore && this.deps.researchTraceVersions) {
        const completedAt = this.clock.now();
        await this.saveResearchTraceSafely({
          schemaVersion: researchTraceSchemaVersion,
          traceId: (this.ids.traceId ?? randomIdGenerator.traceId!)(),
          requestId,
          messageId,
          companyId: participant.companyId,
          groupId: participant.groupId,
          subjectKey: participant.subjectKey,
          processIds: deriveSelectedProcessIds(mergeExecutionTrace(executionTrace, observedExecutionTrace)),
          ...this.deps.researchTraceVersions,
          samplingRate: 1,
          input: { text, modality: inputModality },
          attempts: traceAttempts.length > 0 ? traceAttempts : [researchTraceAttempt(1, systemContextBudget.text, undefined, agentError)],
          usage,
          startedAt: new Date(chatStartedAt).toISOString(),
          completedAt,
          latencyMs: Math.max(0, Date.parse(completedAt) - chatStartedAt),
          status: "failed",
          error: researchTraceError(agentError),
        });
      }
      throw agentError;
    }
    // Work already committed or awaiting confirmation must not be reported as a
    // failure just because the agent stopped without a closing sentence.
    if (response === undefined) response = missingAgentResponseUserMessage;
    const usageWarning = usage ? await this.recordUsageSafely({
      userId,
      requestId,
      threadId,
      messageId,
      usage,
      contextSourceCharacters: usageContextSourceCharacters,
    }) : undefined;
    if (usageWarning) response = appendUsageSoftLimitWarning(response);
    try {
      const appendTurn = this.deps.conversationStore.appendTurn({
        messageId,
        // The existing application history store uses employeeId as its neutral
        // owner key. AssistantService maps its trusted userId only at this seam.
        employeeId: userId,
        subjectKey: participant?.subjectKey ?? userId,
        threadId,
        userText: text,
        agentResponse: response,
        timestamp: this.clock.now(),
      });
      await boundedRecovery(appendTurn, computeRecoveryRemainingMs(chatStartedAt, this.deps.applicationTimeoutMs, this.deps.recoveryReserveMs));
    } catch (error) {
      if (!attemptedTaskProposal && !persistedTaskProposal && !isRecoveryTimeoutError(error)) throw error;
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
    if (participant && this.deps.researchTraceStore && this.deps.researchTraceVersions) {
      const completedAt = this.clock.now();
      await this.saveResearchTraceSafely({
        schemaVersion: researchTraceSchemaVersion,
        traceId: (this.ids.traceId ?? randomIdGenerator.traceId!)(),
        requestId,
        messageId,
        companyId: participant.companyId,
        groupId: participant.groupId,
        subjectKey: participant.subjectKey,
        processIds: selectedProcessIds,
        ...this.deps.researchTraceVersions,
        samplingRate: 1,
        input: { text, modality: inputModality },
        attempts: traceAttempts.length > 0 ? traceAttempts : [researchTraceAttempt(1, systemContextBudget.text)],
        output: response,
        usage,
        startedAt: new Date(chatStartedAt).toISOString(),
        completedAt,
        latencyMs: Math.max(0, Date.parse(completedAt) - chatStartedAt),
        status: "completed",
      });
    }
    const pendingActions = pendingActionSlots
      .slice()
      .sort((left, right) => left.sequence - right.sequence)
      .map((slot): AssistantPendingAction => slot.kind === "task"
        ? pendingTaskAction(slot.pending, slot.title)
        : slot.kind === "idea"
          ? pendingIdeaDeletionAction(slot.record, slot.idea)
          : slot.confirmation);
    return {
      messageId,
      response,
      selectedProcessIds,
      outcome: { status: "completed" },
      personalContextDocuments: personalContext.data.documents.map((document) => document.path),
      pendingActions,
      effect: currentChatEffectState(),
    };
  }

  private async recordUsageSafely(input: {
    userId: string;
    requestId: string;
    threadId: string;
    messageId: string;
    usage: ModelTokenUsage;
    contextSourceCharacters: ContextBudgetResult["contextSourceCharacters"];
  }): Promise<boolean> {
    const { overSoftLimit } = await this.usage.record({
      userId: input.userId,
      requestId: input.requestId,
      source: "chat",
      threadId: input.threadId,
      messageId: input.messageId,
      usage: input.usage,
      contextSourceCharacters: input.contextSourceCharacters,
    });
    return overSoftLimit;
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
      { sourceId: "base_instructions", content: renderAssistantBaseInstructions() },
      { sourceId: "agent_manual", content: renderAssistantAgentManual(agentInstructions, responsePolicy, requiredProcessId) },
      { sourceId: "profile", content: profileSection },
      { sourceId: "context", content: renderAssistantContextProjection(personalContext) },
      { sourceId: "context_index", content: renderAssistantContextIndex(personalContext) },
      ...(records === undefined ? [] : [{ sourceId: "records" as const, content: renderAssistantRecordsProjection(records) }]),
      { sourceId: "thread_summary", content: threadSummarySection },
      { sourceId: "history", content: historySection },
    ],
  });
}

const requestIntegrityDenialResponse = "Не могу выполнить запрос в таком виде: он затрагивает чужие данные или пытается обойти обязательные правила и подтверждение. Уточните, что нужно сделать с вашими данными; для изменения я подготовлю безопасное действие с подтверждением.";
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
export const missingAgentResponseUserMessage =
  "Не удалось сформировать итоговый ответ. Всё, что уже сохранено или подготовлено к подтверждению, не потеряно — проверьте записи и подтверждения; повторять запрос не нужно.";
export const pendingActionGroupLimitUserMessage =
  `За один ответ можно показать не больше ${maximumPendingActionsPerTurn} подтверждений. Показал только эту часть; оставшиеся действия можно запросить следующим сообщением.`;

class PendingActionGroupLimitError extends Error {
  constructor() { super(`pending action group limit of ${maximumPendingActionsPerTurn} reached`); this.name = "PendingActionGroupLimitError"; }
}

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

function researchTraceAttempt(
  attempt: number,
  context: string,
  trace?: AssistantAgentRunTrace,
  error?: unknown,
): ResearchTraceAttempt {
  return {
    attempt,
    context,
    modelSteps: trace?.modelSteps ?? [],
    toolCalls: trace?.toolCalls ?? [],
    toolResults: trace?.toolResults ?? [],
    ...(trace?.model ? { model: trace.model } : {}),
    ...(error === undefined ? {} : { error: researchTraceError(error) }),
  };
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

export function deriveSelectedProcessIds(executionTrace: AssistantExecutionTrace): AssistantProcessId[] {
  const selected: AssistantProcessId[] = ["core"];
  const add = (id: AssistantProcessId | undefined) => {
    if (id && !selected.includes(id)) selected.push(id);
  };
  for (const event of executionTrace) {
    if (event.kind === "tool") add(assistantToolProcessOwners[event.toolName]);
    else if (isAssistantProcessId(event.processId) && (event.processId === "knowledge_lookup" || isAssistantDiagnosticProcessId(event.processId))) add(event.processId);
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
