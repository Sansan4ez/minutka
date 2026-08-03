import { PersonalAssistantService } from "../../application/personal-assistant-service.js";
import type { MinutkaService } from "../../application/minutka-service.js";
import type {
  AcceptConsentRequest, AcceptEmployeeConsentRequest, AdminUsageRequest, ChatRequest, CompleteOnboardingRequest, ContextDocumentVersionsRequest, ServiceChatRequest,
  IssueInviteRequest, ListInsightsRequest, ListParticipantsRequest, OnboardingAnswerRequest, OpenInviteRequest, RedeemTelegramInviteRequest,
  RestoreContextDocumentVersionRequest, SubmitFeedbackRequest, TaskMutationDecisionRequest, ContextDocumentDecisionRequest,
} from "../../contracts/minutka-api.js";
import type {
  AdminMinutkaTransport, EmployeeMinutkaTransport, ServiceEmployeeMinutkaTransport,
  ServiceMinutkaTransport,
} from "../../client/sdk/minutka-client.js";
import type { AuthenticatedPrincipal } from "./auth.js";
import { toScheduleView } from "../../application/schedule-view.js";

type InProcessApplication = MinutkaService | PersonalAssistantService;

function employeeId(principal: AuthenticatedPrincipal): string {
  if (principal.kind !== "employee") throw new Error("employee principal is required");
  return principal.employeeId;
}
function service(principal: AuthenticatedPrincipal): void {
  if (principal.kind !== "service") throw new Error("service principal is required");
}
function operator(principal: AuthenticatedPrincipal): void {
  if (principal.kind !== "operator") throw new Error("operator principal is required");
}
function personal(application: InProcessApplication): PersonalAssistantService {
  if (!(application instanceof PersonalAssistantService)) throw new Error("personal assistant facade is required");
  return application;
}

/** Spec/local employee adapter: binds its principal before calling the application service. */
export class InProcessEmployeeMinutkaTransport implements EmployeeMinutkaTransport {
  constructor(private readonly application: InProcessApplication, private readonly principal: AuthenticatedPrincipal) {}
  chat(input: ChatRequest) {
    const ownerId = employeeId(this.principal);
    return this.application instanceof PersonalAssistantService
      ? this.application.chat({ ...input, userId: ownerId })
      : this.application.chat({ ...input, employeeId: ownerId });
  }
  openInvite(input: OpenInviteRequest) { return this.application.openInvite(input); }
  acceptConsent(input: AcceptEmployeeConsentRequest) { return this.application.acceptConsent({ ...input, employeeId: employeeId(this.principal) }); }
  completeOnboarding(input: CompleteOnboardingRequest) { return this.application.completeOnboarding({ ...input, employeeId: employeeId(this.principal) }); }
  getProfile() { return this.application.getProfile({ employeeId: employeeId(this.principal) }); }
  listInsights(input: ListInsightsRequest) { return this.application.listInsights({ ...input, employeeId: employeeId(this.principal) }); }
  submitFeedback(input: SubmitFeedbackRequest) { return this.application.submitFeedback({ ...input, employeeId: employeeId(this.principal) }); }
  confirmTaskMutation(confirmationId: string, _input: TaskMutationDecisionRequest) { return personal(this.application).confirmTaskMutation(employeeId(this.principal), confirmationId); }
  rejectTaskMutation(confirmationId: string, _input: TaskMutationDecisionRequest) { return personal(this.application).rejectTaskMutation(employeeId(this.principal), confirmationId); }
  confirmContextDocumentMutation(confirmationId: string, _input: ContextDocumentDecisionRequest) { return personal(this.application).confirmContextDocumentMutation(employeeId(this.principal), confirmationId); }
  rejectContextDocumentMutation(confirmationId: string, _input: ContextDocumentDecisionRequest) { return personal(this.application).rejectContextDocumentMutation(employeeId(this.principal), confirmationId); }
  confirmIdeaDeletion(confirmationId: string) { return personal(this.application).confirmIdeaDeletion(employeeId(this.principal), confirmationId); }
  rejectIdeaDeletion(confirmationId: string) { return personal(this.application).rejectIdeaDeletion(employeeId(this.principal), confirmationId); }
  undoIdeaDeletion(ideaId?: string) { return personal(this.application).undoIdeaDeletion(employeeId(this.principal), ideaId); }
}

export class InProcessAdminMinutkaTransport implements AdminMinutkaTransport {
  constructor(private readonly application: InProcessApplication, private readonly principal: AuthenticatedPrincipal) {}
  issueInvite(input: IssueInviteRequest) { operator(this.principal); return this.application.issueInvite(input); }
  listParticipants(input: ListParticipantsRequest) { operator(this.principal); return this.application.listParticipants(input); }
  getMonthlyUsage(input: AdminUsageRequest) { operator(this.principal); return personal(this.application).getMonthlyUsage(input.employeeId, input.month); }
  listContextDocumentVersions(input: ContextDocumentVersionsRequest) { operator(this.principal); return personal(this.application).listContextDocumentVersions(input.employeeId, { path: input.path, limit: input.limit }); }
  restoreContextDocumentVersion(input: RestoreContextDocumentVersionRequest) { operator(this.principal); return personal(this.application).restoreContextDocumentVersion(input.employeeId, { path: input.path, version: input.version }); }
}

/** Service-plane adapter used by the Telegram shell after it resolves an employee privately. */
export class InProcessServiceMinutkaTransport implements ServiceMinutkaTransport, ServiceEmployeeMinutkaTransport {
  constructor(private readonly application: InProcessApplication, private readonly principal: AuthenticatedPrincipal, private readonly scopedEmployeeId?: string) {}
  private employeeId(): string { service(this.principal); if (!this.scopedEmployeeId) throw new Error("service employee scope is required"); return this.scopedEmployeeId; }
  redeemTelegramInvite(input: RedeemTelegramInviteRequest) { service(this.principal); return this.application.redeemTelegramInvite(input); }
  chat(input: ServiceChatRequest) {
    const ownerId = this.employeeId();
    return this.application instanceof PersonalAssistantService
      ? this.application.chat({ ...input, userId: ownerId })
      : this.application.chat({ ...input, employeeId: ownerId });
  }
  recordPrivacyExplanationShown() { return this.application.recordPrivacyExplanationShown({ employeeId: this.employeeId() }); }
  acceptConsent(input: AcceptConsentRequest) { return this.application.acceptConsent({ ...input, employeeId: this.employeeId() }); }
  completeOnboarding(input: CompleteOnboardingRequest) { return this.application.completeOnboarding({ ...input, employeeId: this.employeeId() }); }
  submitOnboardingAnswer(input: OnboardingAnswerRequest) { return this.application.submitOnboardingAnswer({ ...input, employeeId: this.employeeId() }); }
  confirmOnboarding() { return this.application.confirmOnboarding({ employeeId: this.employeeId() }); }
  resetOnboardingDraft() { return this.application.resetOnboardingDraft({ employeeId: this.employeeId() }); }
  getProfile() { return this.application.getProfile({ employeeId: this.employeeId() }); }
  resetConversation() { return personal(this.application).resetConversation({ userId: this.employeeId() }); }
  async listSchedules() { return { schedules: (await personal(this.application).listSchedules(this.employeeId())).map(toScheduleView) }; }
  submitFeedback(input: SubmitFeedbackRequest) { return this.application.submitFeedback({ ...input, employeeId: this.employeeId() }); }
  confirmTaskMutation(confirmationId: string, _input: TaskMutationDecisionRequest) { return personal(this.application).confirmTaskMutation(this.employeeId(), confirmationId); }
  rejectTaskMutation(confirmationId: string, _input: TaskMutationDecisionRequest) { return personal(this.application).rejectTaskMutation(this.employeeId(), confirmationId); }
  confirmContextDocumentMutation(confirmationId: string, _input: ContextDocumentDecisionRequest) { return personal(this.application).confirmContextDocumentMutation(this.employeeId(), confirmationId); }
  rejectContextDocumentMutation(confirmationId: string, _input: ContextDocumentDecisionRequest) { return personal(this.application).rejectContextDocumentMutation(this.employeeId(), confirmationId); }
  confirmIdeaDeletion(confirmationId: string) { return personal(this.application).confirmIdeaDeletion(this.employeeId(), confirmationId); }
  rejectIdeaDeletion(confirmationId: string) { return personal(this.application).rejectIdeaDeletion(this.employeeId(), confirmationId); }
  undoIdeaDeletion(ideaId?: string) { return personal(this.application).undoIdeaDeletion(this.employeeId(), ideaId); }
  forEmployee(employeeId: string): ServiceEmployeeMinutkaTransport { service(this.principal); if (!employeeId) throw new Error("employeeId is required for service scope"); return new InProcessServiceMinutkaTransport(this.application, this.principal, employeeId); }
}

export function createInProcessEmployeeTransport(application: InProcessApplication, principal: AuthenticatedPrincipal): EmployeeMinutkaTransport {
  return new InProcessEmployeeMinutkaTransport(application, principal);
}
export function createInProcessAdminTransport(application: InProcessApplication, principal: AuthenticatedPrincipal): AdminMinutkaTransport {
  return new InProcessAdminMinutkaTransport(application, principal);
}
export function createInProcessServiceTransport(application: InProcessApplication, principal: AuthenticatedPrincipal): ServiceMinutkaTransport {
  return new InProcessServiceMinutkaTransport(application, principal);
}
