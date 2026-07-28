import type { AssistantChatInput, AssistantChatResult, AssistantService } from "./assistant-service.js";
import type { ArtifactReference, ArtifactStore, SaveArtifactInput, SaveArtifactResult } from "./artifact-store.js";
import type {
  AcceptConsentInput,
  AcceptConsentResult,
  CompleteOnboardingInput,
  CompleteOnboardingResult,
  ConfirmOnboardingInput,
  IssueInviteInput,
  IssueInviteResult,
  ListInsightsInput,
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
} from "./minutka-service.js";
import type { OnboardingProgress } from "./onboarding-types.js";
import type { IdeaToTaskConfirmationResult, IdeaToTaskProposalResult, IdeaToTaskService } from "./idea-to-task.js";
import type {
  PendingTaskMutation,
  TaskMutationConfirmationResult,
  TaskMutationConfirmationService,
  TaskMutationProposal,
} from "./task-mutation-confirmation.js";
import type { StructuredInsight } from "../domain/insights.js";
import type { UserProfile } from "../domain/employee.js";

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
      | "openInvite"
      | "recordPrivacyExplanationShown"
      | "redeemTelegramInvite"
      | "acceptConsent"
      | "completeOnboarding"
      | "submitOnboardingAnswer"
      | "confirmOnboarding"
      | "resetOnboardingDraft"
      | "getProfile"
      | "listInsights"
      | "submitFeedback"
    >,
    private readonly conversationService: Pick<AssistantService, "chat">,
    private readonly artifactStore: Pick<ArtifactStore, "save" | "get" | "list" | "delete">,
    private readonly taskMutations?: Pick<TaskMutationConfirmationService, "propose" | "confirm">,
    private readonly ideaToTask?: Pick<IdeaToTaskService, "propose" | "confirm">,
  ) {}

  issueInvite(input: IssueInviteInput): Promise<IssueInviteResult> {
    return this.identityService.issueInvite(input);
  }

  openInvite(input: OpenInviteInput): Promise<OpenInviteResult> {
    return this.identityService.openInvite(input);
  }

  recordPrivacyExplanationShown(input: RecordPrivacyExplanationShownInput): Promise<void> {
    return this.identityService.recordPrivacyExplanationShown(input);
  }

  redeemTelegramInvite(input: RedeemTelegramInviteInput): Promise<RedeemTelegramInviteResult> {
    return this.identityService.redeemTelegramInvite(input);
  }

  acceptConsent(input: AcceptConsentInput): Promise<AcceptConsentResult> {
    return this.identityService.acceptConsent(input);
  }

  completeOnboarding(input: CompleteOnboardingInput): Promise<CompleteOnboardingResult> {
    return this.identityService.completeOnboarding(input);
  }

  submitOnboardingAnswer(input: SubmitOnboardingAnswerInput): Promise<OnboardingProgress> {
    return this.identityService.submitOnboardingAnswer(input);
  }

  confirmOnboarding(input: ConfirmOnboardingInput): Promise<CompleteOnboardingResult> {
    return this.identityService.confirmOnboarding(input);
  }

  resetOnboardingDraft(input: ResetOnboardingDraftInput): Promise<OnboardingProgress> {
    return this.identityService.resetOnboardingDraft(input);
  }

  getProfile(input: { employeeId: string }): Promise<UserProfile> {
    return this.identityService.getProfile(input);
  }

  chat(input: AssistantChatInput): Promise<AssistantChatResult> {
    return this.conversationService.chat(input);
  }

  proposeTaskMutation(ownerId: string, proposal: TaskMutationProposal): Promise<PendingTaskMutation> {
    if (!this.taskMutations) throw new Error("task mutation confirmation is not configured");
    return this.taskMutations.propose(ownerId, proposal);
  }

  confirmTaskMutation(ownerId: string, confirmationId: string, proposal: TaskMutationProposal): Promise<TaskMutationConfirmationResult> {
    if (!this.taskMutations) throw new Error("task mutation confirmation is not configured");
    return this.taskMutations.confirm(ownerId, confirmationId, proposal);
  }

  proposeIdeaToTask(ownerId: string, ideaId: string): Promise<IdeaToTaskProposalResult> {
    if (!this.ideaToTask) throw new Error("idea to task conversion is not configured");
    return this.ideaToTask.propose(ownerId, ideaId);
  }

  confirmIdeaToTask(ownerId: string, confirmationId: string, confirmation: PendingTaskMutation): Promise<IdeaToTaskConfirmationResult> {
    if (!this.ideaToTask) throw new Error("idea to task conversion is not configured");
    return this.ideaToTask.confirm(ownerId, confirmationId, confirmation);
  }

  listInsights(input: ListInsightsInput): Promise<StructuredInsight[]> {
    return this.identityService.listInsights(input);
  }

  submitFeedback(input: SubmitFeedbackInput): Promise<SubmitFeedbackResult> {
    return this.identityService.submitFeedback(input);
  }

  saveArtifact(input: SaveArtifactInput): Promise<SaveArtifactResult> {
    return this.artifactStore.save(input);
  }

  getArtifact(ownerId: string, artifactId: string): Promise<ArtifactReference | null> {
    return this.artifactStore.get(ownerId, artifactId);
  }

  listArtifacts(ownerId: string): Promise<ArtifactReference[]> {
    return this.artifactStore.list(ownerId);
  }

  deleteArtifact(ownerId: string, artifactId: string): Promise<ArtifactReference | null> {
    return this.artifactStore.delete(ownerId, artifactId);
  }
}
