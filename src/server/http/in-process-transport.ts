import type { MinutkaService } from "../../application/minutka-service.js";
import type {
  AcceptConsentRequest, AcceptEmployeeConsentRequest, ChatRequest, CompleteOnboardingRequest,
  IssueInviteRequest, ListInsightsRequest, OpenInviteRequest, RedeemTelegramInviteRequest,
  SubmitFeedbackRequest,
} from "../../contracts/minutka-api.js";
import type {
  AdminMinutkaTransport, EmployeeMinutkaTransport, ServiceEmployeeMinutkaTransport,
  ServiceMinutkaTransport,
} from "../../client/sdk/minutka-client.js";
import type { AuthenticatedPrincipal } from "./auth.js";

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

/** Spec/local employee adapter: binds its principal before calling the application service. */
export class InProcessEmployeeMinutkaTransport implements EmployeeMinutkaTransport {
  constructor(private readonly service: MinutkaService, private readonly principal: AuthenticatedPrincipal) {}
  chat(input: ChatRequest) { return this.service.chat({ ...input, employeeId: employeeId(this.principal) }); }
  openInvite(input: OpenInviteRequest) { return this.service.openInvite(input); }
  acceptConsent(input: AcceptEmployeeConsentRequest) { return this.service.acceptConsent({ ...input, employeeId: employeeId(this.principal) }); }
  completeOnboarding(input: CompleteOnboardingRequest) { return this.service.completeOnboarding({ ...input, employeeId: employeeId(this.principal) }); }
  getProfile() { return this.service.getProfile({ employeeId: employeeId(this.principal) }); }
  listInsights(input: ListInsightsRequest) { return this.service.listInsights({ ...input, employeeId: employeeId(this.principal) }); }
  submitFeedback(input: SubmitFeedbackRequest) { return this.service.submitFeedback({ ...input, employeeId: employeeId(this.principal) }); }
}

export class InProcessAdminMinutkaTransport implements AdminMinutkaTransport {
  constructor(private readonly service: MinutkaService, private readonly principal: AuthenticatedPrincipal) {}
  issueInvite(input: IssueInviteRequest) { operator(this.principal); return this.service.issueInvite(input); }
}

/** Service-plane adapter used by the Telegram shell after it resolves an employee privately. */
export class InProcessServiceMinutkaTransport implements ServiceMinutkaTransport, ServiceEmployeeMinutkaTransport {
  constructor(private readonly service: MinutkaService, private readonly principal: AuthenticatedPrincipal, private readonly scopedEmployeeId?: string) {}
  private employeeId(): string { service(this.principal); if (!this.scopedEmployeeId) throw new Error("service employee scope is required"); return this.scopedEmployeeId; }
  redeemTelegramInvite(input: RedeemTelegramInviteRequest) { service(this.principal); return this.service.redeemTelegramInvite(input); }
  chat(input: ChatRequest) { return this.service.chat({ ...input, employeeId: this.employeeId() }); }
  recordPrivacyExplanationShown() { return this.service.recordPrivacyExplanationShown({ employeeId: this.employeeId() }); }
  acceptConsent(input: AcceptConsentRequest) { return this.service.acceptConsent({ ...input, employeeId: this.employeeId() }); }
  completeOnboarding(input: CompleteOnboardingRequest) { return this.service.completeOnboarding({ ...input, employeeId: this.employeeId() }); }
  getProfile() { return this.service.getProfile({ employeeId: this.employeeId() }); }
  submitFeedback(input: SubmitFeedbackRequest) { return this.service.submitFeedback({ ...input, employeeId: this.employeeId() }); }
  forEmployee(employeeId: string): ServiceEmployeeMinutkaTransport { service(this.principal); if (!employeeId) throw new Error("employeeId is required for service scope"); return new InProcessServiceMinutkaTransport(this.service, this.principal, employeeId); }
}

export function createInProcessEmployeeTransport(service: MinutkaService, principal: AuthenticatedPrincipal): EmployeeMinutkaTransport {
  return new InProcessEmployeeMinutkaTransport(service, principal);
}
export function createInProcessAdminTransport(service: MinutkaService, principal: AuthenticatedPrincipal): AdminMinutkaTransport {
  return new InProcessAdminMinutkaTransport(service, principal);
}
export function createInProcessServiceTransport(service: MinutkaService, principal: AuthenticatedPrincipal): ServiceMinutkaTransport {
  return new InProcessServiceMinutkaTransport(service, principal);
}
