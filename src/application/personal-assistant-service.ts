import type { AssistantChatInput, AssistantChatResult, AssistantService } from "./assistant-service.js";
import type { ArtifactCapacityCheckInput, ArtifactCapacitySnapshot } from "./artifact-capacity.js";
import type { ArtifactReference, ArtifactStore, SaveArtifactInput, SaveArtifactResult } from "./artifact-store.js";
import type {
  AcceptConsentInput,
  AcceptConsentResult,
  CompleteOnboardingInput,
  CompleteOnboardingResult,
  ConfirmOnboardingInput,
  DeleteInvitedParticipantInput,
  DeleteInvitedParticipantResult,
  GetOnboardingProgressInput,
  GetPersonalContextInput,
  IssueInviteInput,
  IssueInviteResult,
  ListInsightsInput,
  ParticipantPage,
  MinutkaService,
  MinutkaServiceDeps,
  OpenInviteInput,
  OpenInviteResult,
  RecordPrivacyExplanationShownInput,
  RedeemTelegramInviteInput,
  RedeemTelegramInviteResult,
  ResetOnboardingDraftInput,
  SubmitFeedbackInput,
  SubmitFeedbackResult,
  SubmitOnboardingAnswerInput,
  UpdatePersonalContextInput,
} from "./minutka-service.js";
import type { ListParticipantsInput } from "./participant-pagination.js";
import type { OnboardingProgress } from "./onboarding-types.js";
import type { TaskMutationAuditContext, TaskMutationConfirmationService } from "./task-mutation-confirmation.js";
import type { StructuredInsight } from "../domain/insights.js";
import type { UserProfile } from "../domain/employee.js";
import type { AssistantScheduledProcessId } from "../domain/assistant-process.js";
import type { ConversationThreadService } from "./conversation-thread-service.js";
import type { IdeaDeletionAuditContext, IdeaDeletionService } from "./idea-deletion.js";
import type { ProcessSchedule } from "../domain/schedule.js";
import type { SaveDailyScheduleInput, ScheduleManagementService } from "./schedule-management-service.js";
import type { MonthlyUsage, UsageStore } from "./usage-store.js";
import type { ContextDocumentAuditContext, ContextDocumentService } from "./context-document-service.js";
import type { CompanyReportingService } from "./company-reporting.js";

/** Product runtime dependencies while legacy identity/onboarding remains an internal collaborator. */
export type PersonalAssistantRuntimeInput = {
  assistantAgentRunner: import("./assistant-service.js").AssistantAgentRunner;
  env: NodeJS.ProcessEnv;
  deps?: Omit<MinutkaServiceDeps, "profileStore" | "conversationStore" | "insightStore" | "feedbackStore" | "auditEventStore" | "clock" | "idGenerator">;
};

/**
 * Product-facing application facade for the personal assistant.
 *
 * The legacy identity/onboarding service and the personal chat service remain
 * internal collaborators during the incremental migration. Transports receive
 * this facade instead of selecting a collaborator or accessing a store.
 */
export class PersonalAssistantService {
  constructor(
    private readonly identityService: Pick<MinutkaService,
      | "issueInvite"
      | "deleteInvitedParticipant"
      | "listParticipants"
      | "openInvite"
      | "recordPrivacyExplanationShown"
      | "redeemTelegramInvite"
      | "acceptConsent"
      | "completeOnboarding"
      | "getOnboardingProgress"
      | "submitOnboardingAnswer"
      | "confirmOnboarding"
      | "resetOnboardingDraft"
      | "getProfile"
      | "getPersonalContext"
      | "updatePersonalContext"
      | "listInsights"
      | "submitFeedback"
    >,
    private readonly conversationService: Pick<AssistantService, "chat">,
    private readonly artifactStore: Pick<ArtifactStore, "checkCapacity" | "save" | "get" | "list" | "delete">,
    private readonly taskMutations?: Pick<TaskMutationConfirmationService, "confirm" | "reject" | "undo">,
    private readonly conversationThreads?: Pick<ConversationThreadService, "reset">,
    private readonly ideaDeletions?: Pick<IdeaDeletionService, "confirm" | "reject" | "undo">,
    private readonly schedules?: Pick<ScheduleManagementService, "listSchedules" | "saveDailySchedule" | "disableSchedule">,
    private readonly usage?: Pick<UsageStore, "getMonthly">,
    private readonly contextDocuments?: Pick<ContextDocumentService, "confirm" | "reject" | "listVersions" | "restoreVersion">,
    private readonly companyReporting?: Pick<CompanyReportingService, "exportGroup">,
  ) {}

  issueInvite(input: IssueInviteInput): Promise<IssueInviteResult> { return this.identityService.issueInvite(input); }
  deleteInvitedParticipant(input: DeleteInvitedParticipantInput): Promise<DeleteInvitedParticipantResult> { return this.identityService.deleteInvitedParticipant(input); }
  listParticipants(input: ListParticipantsInput): Promise<ParticipantPage> { return this.identityService.listParticipants(input); }
  getMonthlyUsage(userId: string, month: string): Promise<MonthlyUsage> {
    if (!this.usage) throw new Error("usage reporting is not configured");
    return this.usage.getMonthly(userId, month);
  }
  exportCompanyReport(input: { companyId: string; groupId: string }) {
    if (!this.companyReporting) throw new Error("company reporting is not configured");
    return this.companyReporting.exportGroup(input);
  }
  openInvite(input: OpenInviteInput): Promise<OpenInviteResult> { return this.identityService.openInvite(input); }
  recordPrivacyExplanationShown(input: RecordPrivacyExplanationShownInput): Promise<void> { return this.identityService.recordPrivacyExplanationShown(input); }
  redeemTelegramInvite(input: RedeemTelegramInviteInput): Promise<RedeemTelegramInviteResult> { return this.identityService.redeemTelegramInvite(input); }
  acceptConsent(input: AcceptConsentInput): Promise<AcceptConsentResult> { return this.identityService.acceptConsent(input); }
  completeOnboarding(input: CompleteOnboardingInput): Promise<CompleteOnboardingResult> { return this.identityService.completeOnboarding(input); }
  getOnboardingProgress(input: GetOnboardingProgressInput): Promise<OnboardingProgress> { return this.identityService.getOnboardingProgress(input); }
  submitOnboardingAnswer(input: SubmitOnboardingAnswerInput): Promise<OnboardingProgress> { return this.identityService.submitOnboardingAnswer(input); }
  confirmOnboarding(input: ConfirmOnboardingInput): Promise<CompleteOnboardingResult> { return this.identityService.confirmOnboarding(input); }
  resetOnboardingDraft(input: ResetOnboardingDraftInput): Promise<OnboardingProgress> { return this.identityService.resetOnboardingDraft(input); }
  getProfile(input: { employeeId: string }): Promise<UserProfile> { return this.identityService.getProfile(input); }
  getPersonalContext(input: GetPersonalContextInput) { return this.identityService.getPersonalContext(input); }
  updatePersonalContext(input: UpdatePersonalContextInput) { return this.identityService.updatePersonalContext(input); }
  chat(input: AssistantChatInput): Promise<AssistantChatResult> { return this.conversationService.chat(input); }

  resetConversation(input: { userId: string }): Promise<{ threadId: string }> {
    if (!this.conversationThreads) throw new Error("conversation thread reset is not configured");
    return this.conversationThreads.reset(input);
  }

  listSchedules(userId: string): Promise<ProcessSchedule[]> {
    if (!this.schedules) throw new Error("schedule management is not configured");
    return this.schedules.listSchedules(userId);
  }

  saveDailySchedule(userId: string, input: SaveDailyScheduleInput): Promise<ProcessSchedule> {
    if (!this.schedules) throw new Error("schedule management is not configured");
    return this.schedules.saveDailySchedule(userId, input);
  }

  disableSchedule(userId: string, scheduleId: string): Promise<ProcessSchedule | null> {
    if (!this.schedules) throw new Error("schedule management is not configured");
    return this.schedules.disableSchedule(userId, scheduleId);
  }

  runScheduledProcess(input: { userId: string; threadId: string; processId: AssistantScheduledProcessId }): Promise<AssistantChatResult> {
    return this.conversationService.chat({
      userId: input.userId,
      threadId: input.threadId,
      text: scheduledProcessPrompt(input.processId),
      responseChannel: "telegram",
      requiredProcessId: input.processId,
    });
  }

  confirmTaskMutation(ownerId: string, confirmationId: string, audit?: TaskMutationAuditContext) {
    if (!this.taskMutations) throw new Error("task mutation confirmation is not configured");
    return this.taskMutations.confirm(ownerId, confirmationId, audit);
  }

  rejectTaskMutation(ownerId: string, confirmationId: string, audit?: TaskMutationAuditContext) {
    if (!this.taskMutations) throw new Error("task mutation confirmation is not configured");
    return this.taskMutations.reject(ownerId, confirmationId, audit);
  }

  undoTaskMutation(ownerId: string, audit?: TaskMutationAuditContext) {
    if (!this.taskMutations) throw new Error("task mutation confirmation is not configured");
    return this.taskMutations.undo(ownerId, audit);
  }

  confirmContextDocumentMutation(ownerId: string, confirmationId: string, audit?: ContextDocumentAuditContext) {
    if (!this.contextDocuments) throw new Error("context document mutation confirmation is not configured");
    return this.contextDocuments.confirm(ownerId, confirmationId, audit);
  }

  rejectContextDocumentMutation(ownerId: string, confirmationId: string, audit?: ContextDocumentAuditContext) {
    if (!this.contextDocuments) throw new Error("context document mutation confirmation is not configured");
    return this.contextDocuments.reject(ownerId, confirmationId, audit);
  }

  listContextDocumentVersions(ownerId: string, input: { path: string; limit?: number }) {
    if (!this.contextDocuments) throw new Error("context document management is not configured");
    return this.contextDocuments.listVersions(ownerId, input);
  }

  restoreContextDocumentVersion(ownerId: string, input: { path: string; version: string }, audit?: ContextDocumentAuditContext) {
    if (!this.contextDocuments) throw new Error("context document management is not configured");
    return this.contextDocuments.restoreVersion(ownerId, input, audit);
  }

  confirmIdeaDeletion(ownerId: string, confirmationId: string, audit?: IdeaDeletionAuditContext) {
    if (!this.ideaDeletions) throw new Error("idea deletion confirmation is not configured");
    return this.ideaDeletions.confirm(ownerId, confirmationId, audit);
  }

  rejectIdeaDeletion(ownerId: string, confirmationId: string, audit?: IdeaDeletionAuditContext) {
    if (!this.ideaDeletions) throw new Error("idea deletion confirmation is not configured");
    return this.ideaDeletions.reject(ownerId, confirmationId, audit);
  }

  undoIdeaDeletion(ownerId: string, ideaId?: string) {
    if (!this.ideaDeletions) throw new Error("idea deletion confirmation is not configured");
    return this.ideaDeletions.undo(ownerId, ideaId ? { ideaId } : {});
  }

  listInsights(input: ListInsightsInput): Promise<StructuredInsight[]> { return this.identityService.listInsights(input); }
  submitFeedback(input: SubmitFeedbackInput): Promise<SubmitFeedbackResult> { return this.identityService.submitFeedback(input); }
  checkArtifactCapacity(input: ArtifactCapacityCheckInput): Promise<ArtifactCapacitySnapshot> { return this.artifactStore.checkCapacity(input); }
  saveArtifact(input: SaveArtifactInput): Promise<SaveArtifactResult> { return this.artifactStore.save(input); }
  getArtifact(ownerId: string, artifactId: string): Promise<ArtifactReference | null> { return this.artifactStore.get(ownerId, artifactId); }
  listArtifacts(ownerId: string): Promise<ArtifactReference[]> { return this.artifactStore.list(ownerId); }
  deleteArtifact(ownerId: string, artifactId: string): Promise<ArtifactReference | null> { return this.artifactStore.delete(ownerId, artifactId); }
}

function scheduledProcessPrompt(processId: AssistantScheduledProcessId): string {
  if (processId === "morning_planning") return "Проведи короткое утреннее планирование по процессу morning_planning: при необходимости предложи один безопасный вопрос о пропущенных вчерашних фактических активностях, затем предложи назвать до трёх приоритетов на сегодня и один конкретный первый шаг. В этом сообщении ничего не записывай; запись выполняется по ответу сотрудника. Не записывай планы как активности.";
  if (processId === "evening_reflection") return "Проведи вечернюю рефлексию по процессу evening_reflection: предложи назвать фактически выполненные или начатые активности без ограничения их количества, главное препятствие и необязательный сигнал энергии. В этом сообщении ничего не записывай; запись выполняется по ответу сотрудника. Не записывай запланированное или не начатое.";
  if (processId === "weekly_summary") return "Проведи недельный чекпойнт по процессу weekly_summary: вызови readWeeklyActivities и покажи личную сводку только по возвращённым данным. Если данных за неделю мало, скажи об этом прямо и не достраивай картину. Предложи подтвердить или поправить замеченное.";
  if (processId === "final_report") return "Подведи итог двухнедельного цикла по процессу final_report: вызови readCycleActivities и опиши только подтверждённые за цикл паттерны, повторяющиеся задачи, сигналы энергии и места трения из возвращённых данных. Если данных за цикл мало, скажи об этом прямо и ограничься тем, что есть. Заверши личным планом из двух-трёх конкретных шагов упрощения. Ничего не записывай.";
  return assertNever(processId);
}

function assertNever(value: never): never {
  throw new Error(`unsupported scheduled process: ${value}`);
}
