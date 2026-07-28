import { PersonalAssistantService } from "../../application/personal-assistant-service.js";
import type { MinutkaService } from "../../application/minutka-service.js";
import type {
  AcceptConsentRequest, AcceptEmployeeConsentRequest, ChatRequest, CompleteOnboardingRequest, ConfirmIdeaToTaskRequest, ConfirmTaskMutationRequest, ServiceChatRequest,
  IssueInviteRequest, ListInsightsRequest, OnboardingAnswerRequest, OpenInviteRequest, ProposeIdeaToTaskRequest, RedeemTelegramInviteRequest,
  SubmitFeedbackRequest, TaskMutationProposalRequest,
} from "../../contracts/minutka-api.js";
import type {
  AdminMinutkaTransport, EmployeeMinutkaTransport, ServiceEmployeeMinutkaTransport,
  ServiceMinutkaTransport,
} from "../../client/sdk/minutka-client.js";
import type { AuthenticatedPrincipal } from "./auth.js";

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
  proposeTaskMutation(input: TaskMutationProposalRequest) { return personal(this.application).proposeTaskMutation(employeeId(this.principal), input.proposal); }
  confirmTaskMutation(confirmationId: string, input: ConfirmTaskMutationRequest) { return personal(this.application).confirmTaskMutation(employeeId(this.principal), confirmationId, input.proposal); }
  proposeIdeaToTask(input: ProposeIdeaToTaskRequest) { return personal(this.application).proposeIdeaToTask(employeeId(this.principal), input.ideaId); }
  confirmIdeaToTask(confirmationId: string, input: ConfirmIdeaToTaskRequest) { return personal(this.application).confirmIdeaToTask(employeeId(this.principal), confirmationId, input.confirmation); }
}

export class InProcessAdminMinutkaTransport implements AdminMinutkaTransport {
  constructor(private readonly application: InProcessApplication, private readonly principal: AuthenticatedPrincipal) {}
  issueInvite(input: IssueInviteRequest) { operator(this.principal); return this.application.issueInvite(input); }
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
  submitFeedback(input: SubmitFeedbackRequest) { return this.application.submitFeedback({ ...input, employeeId: this.employeeId() }); }
  proposeTaskMutation(input: TaskMutationProposalRequest) { return personal(this.application).proposeTaskMutation(this.employeeId(), input.proposal); }
  confirmTaskMutation(confirmationId: string, input: ConfirmTaskMutationRequest) { return personal(this.application).confirmTaskMutation(this.employeeId(), confirmationId, input.proposal); }
  proposeIdeaToTask(input: ProposeIdeaToTaskRequest) { return personal(this.application).proposeIdeaToTask(this.employeeId(), input.ideaId); }
  confirmIdeaToTask(confirmationId: string, input: ConfirmIdeaToTaskRequest) { return personal(this.application).confirmIdeaToTask(this.employeeId(), confirmationId, input.confirmation); }
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
