import {
  acceptConsentRequestSchema, acceptConsentResponseSchema, acceptEmployeeConsentRequestSchema,
  chatRequestSchema, chatResponseSchema, completeOnboardingRequestSchema, completeOnboardingResponseSchema,
  issueInviteRequestSchema, issueInviteResponseSchema, listInsightsRequestSchema, onboardingAnswerRequestSchema, onboardingProgressSchema, openInviteRequestSchema,
  openInviteResponseSchema, redeemTelegramInviteRequestSchema, redeemTelegramInviteResponseSchema,
  structuredInsightSchema, submitFeedbackRequestSchema, submitFeedbackResponseSchema, userProfileSchema,
  type AcceptConsentRequest, type AcceptEmployeeConsentRequest, type ChatRequest,
  type CompleteOnboardingRequest, type IssueInviteRequest, type ListInsightsRequest,
  type OnboardingAnswerRequest, type OpenInviteRequest, type RedeemTelegramInviteRequest, type SubmitFeedbackRequest,
} from "../../contracts/minutka-api.js";
import { z } from "zod";

/** Ports are deliberately split by principal. A facade can only expose its allowed plane. */
export type EmployeeMinutkaTransport = {
  chat(input: ChatRequest): Promise<unknown>;
  openInvite(input: OpenInviteRequest): Promise<unknown>;
  acceptConsent(input: AcceptEmployeeConsentRequest): Promise<unknown>;
  completeOnboarding(input: CompleteOnboardingRequest): Promise<unknown>;
  getProfile(): Promise<unknown>;
  listInsights(input: ListInsightsRequest): Promise<unknown>;
  submitFeedback(input: SubmitFeedbackRequest): Promise<unknown>;
};
export type AdminMinutkaTransport = { issueInvite(input: IssueInviteRequest): Promise<unknown> };
export type ServiceEmployeeMinutkaTransport = {
  chat(input: ChatRequest): Promise<unknown>;
  recordPrivacyExplanationShown(): Promise<unknown>;
  acceptConsent(input: AcceptConsentRequest): Promise<unknown>;
  completeOnboarding(input: CompleteOnboardingRequest): Promise<unknown>;
  submitOnboardingAnswer(input: OnboardingAnswerRequest): Promise<unknown>;
  confirmOnboarding(): Promise<unknown>;
  resetOnboardingDraft(): Promise<unknown>;
  getProfile(): Promise<unknown>;
  submitFeedback(input: SubmitFeedbackRequest): Promise<unknown>;
};
export type ServiceMinutkaTransport = {
  redeemTelegramInvite(input: RedeemTelegramInviteRequest): Promise<unknown>;
  forEmployee(employeeId: string): ServiceEmployeeMinutkaTransport;
};

function validate<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`${label} validation failed: ${result.error.issues.map((issue) => issue.message).join(", ")}`);
  return result.data;
}

/** Employee-only SDK surface, used by standalone employee CLI and future web clients. */
export class EmployeeMinutkaClient {
  constructor(private readonly transport: EmployeeMinutkaTransport) {}
  async chat(input: unknown) { return validate(chatResponseSchema, await this.transport.chat(validate(chatRequestSchema, input, "chat request")), "chat response"); }
  async openInvite(input: unknown) { return validate(openInviteResponseSchema, await this.transport.openInvite(validate(openInviteRequestSchema, input, "openInvite request")), "openInvite response"); }
  async acceptConsent(input: unknown) { return validate(acceptConsentResponseSchema, await this.transport.acceptConsent(validate(acceptEmployeeConsentRequestSchema, input, "acceptConsent request")), "acceptConsent response"); }
  async completeOnboarding(input: unknown) { return validate(completeOnboardingResponseSchema, await this.transport.completeOnboarding(validate(completeOnboardingRequestSchema, input, "completeOnboarding request")), "completeOnboarding response"); }
  async getProfile() { return validate(userProfileSchema, await this.transport.getProfile(), "getProfile response"); }
  async listInsights(input: unknown = {}) { return validate(z.array(structuredInsightSchema), await this.transport.listInsights(validate(listInsightsRequestSchema, input, "listInsights request")), "listInsights response"); }
  async submitFeedback(input: unknown) { return validate(submitFeedbackResponseSchema, await this.transport.submitFeedback(validate(submitFeedbackRequestSchema, input, "submitFeedback request")), "submitFeedback response"); }
}

/** Operator-only SDK surface. */
export class AdminMinutkaClient {
  constructor(private readonly transport: AdminMinutkaTransport) {}
  async issueInvite(input: unknown) { return validate(issueInviteResponseSchema, await this.transport.issueInvite(validate(issueInviteRequestSchema, input, "issueInvite request")), "issueInvite response"); }
}

/** Service-only per-employee surface used after Telegram's private identity lookup. */
export class ServiceEmployeeMinutkaClient {
  constructor(private readonly transport: ServiceEmployeeMinutkaTransport) {}
  async chat(input: unknown) { return validate(chatResponseSchema, await this.transport.chat(validate(chatRequestSchema, input, "chat request")), "chat response"); }
  async recordPrivacyExplanationShown() { await this.transport.recordPrivacyExplanationShown(); }
  async acceptConsent(input: unknown) { return validate(acceptConsentResponseSchema, await this.transport.acceptConsent(validate(acceptConsentRequestSchema, input, "acceptConsent request")), "acceptConsent response"); }
  async completeOnboarding(input: unknown) { return validate(completeOnboardingResponseSchema, await this.transport.completeOnboarding(validate(completeOnboardingRequestSchema, input, "completeOnboarding request")), "completeOnboarding response"); }
  async submitOnboardingAnswer(input: unknown) { return validate(onboardingProgressSchema, await this.transport.submitOnboardingAnswer(validate(onboardingAnswerRequestSchema, input, "onboarding answer request")), "onboarding progress"); }
  async confirmOnboarding() { return validate(completeOnboardingResponseSchema, await this.transport.confirmOnboarding(), "confirm onboarding response"); }
  async resetOnboardingDraft() { return validate(onboardingProgressSchema, await this.transport.resetOnboardingDraft(), "reset onboarding response"); }
  async getProfile() { return validate(userProfileSchema, await this.transport.getProfile(), "getProfile response"); }
  async submitFeedback(input: unknown) { return validate(submitFeedbackResponseSchema, await this.transport.submitFeedback(validate(submitFeedbackRequestSchema, input, "submitFeedback request")), "submitFeedback response"); }
}

/** Service-only SDK surface. It cannot be used as an employee client. */
export class ServiceMinutkaClient {
  constructor(private readonly transport: ServiceMinutkaTransport) {}
  async redeemTelegramInvite(input: unknown) { return validate(redeemTelegramInviteResponseSchema, await this.transport.redeemTelegramInvite(validate(redeemTelegramInviteRequestSchema, input, "redeemTelegramInvite request")), "redeemTelegramInvite response"); }
  forEmployee(employeeId: string): ServiceEmployeeMinutkaClient {
    if (!employeeId) throw new Error("employeeId is required for service scope");
    return new ServiceEmployeeMinutkaClient(this.transport.forEmployee(employeeId));
  }
}

export type MinutkaCliClient = EmployeeMinutkaClient | AdminMinutkaClient;
export type IssueInviteResult = z.infer<typeof issueInviteResponseSchema>;
export type OpenInviteResult = z.infer<typeof openInviteResponseSchema>;
export type RedeemTelegramInviteResult = z.infer<typeof redeemTelegramInviteResponseSchema>;
export type AcceptConsentResult = z.infer<typeof acceptConsentResponseSchema>;
export type ChatResult = z.infer<typeof chatResponseSchema>;
export type CompleteOnboardingResult = z.infer<typeof completeOnboardingResponseSchema>;
export type OnboardingProgressResult = z.infer<typeof onboardingProgressSchema>;
export type SubmitFeedbackResult = z.infer<typeof submitFeedbackResponseSchema>;
export type UserProfileResult = z.infer<typeof userProfileSchema>;
export type StructuredInsightResult = z.infer<typeof structuredInsightSchema>;
