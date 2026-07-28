import {
  errorEnvelopeSchema,
  type AcceptConsentRequest, type AcceptEmployeeConsentRequest, type ChatRequest,
  type CompleteOnboardingRequest, type ConfirmIdeaToTaskRequest, type ConfirmTaskMutationRequest, type IssueInviteRequest, type ServiceChatRequest, type ListInsightsRequest,
  type OnboardingAnswerRequest, type OpenInviteRequest, type ProposeIdeaToTaskRequest, type RedeemTelegramInviteRequest, type SubmitFeedbackRequest, type TaskMutationProposalRequest,
} from "../../contracts/minutka-api.js";
import type {
  AdminMinutkaTransport, EmployeeMinutkaTransport, ServiceEmployeeMinutkaTransport,
  ServiceMinutkaTransport,
} from "./minutka-client.js";

export class MinutkaApiError extends Error {
  constructor(readonly code: string, readonly requestId?: string, message = "API request failed") { super(message); this.name = "MinutkaApiError"; }
}
export type HttpMinutkaTransportOptions = { baseUrl: string; token: string; timeoutMs?: number; employeeId?: string };

class HttpTransportBase {
  protected readonly baseUrl: string;
  protected readonly timeoutMs: number;
  constructor(protected readonly options: HttpMinutkaTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, ""); this.timeoutMs = options.timeoutMs ?? 110_000;
    if (!/^https?:\/\//.test(this.baseUrl)) throw new Error("MINUTKA_API_URL must be an http(s) URL");
    if (!options.token) throw new Error("MINUTKA_API_TOKEN is required");
  }
  protected async request(method: string, path: string, payload?: unknown): Promise<unknown> {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}${path}`, { method, headers: { authorization: `Bearer ${this.options.token}`, ...(payload === undefined ? {} : { "content-type": "application/json" }) }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: controller.signal });
      if (response.status === 204) return undefined;
      const value: unknown = await response.json().catch(() => undefined);
      if (!response.ok) { const error = errorEnvelopeSchema.safeParse(value); if (error.success) throw new MinutkaApiError(error.data.error.code, error.data.error.requestId, error.data.error.message); throw new MinutkaApiError("internal_error", response.headers.get("x-request-id") ?? undefined); }
      return value;
    } catch (error) {
      if (error instanceof MinutkaApiError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw new MinutkaApiError("request_timeout", undefined, "API request timed out.");
      throw new MinutkaApiError("transport_unavailable", undefined, "API is unavailable.");
    } finally { clearTimeout(timer); }
  }
}

/** Employee-only HTTP transport. No privileged operations exist on this class. */
export class HttpEmployeeMinutkaTransport extends HttpTransportBase implements EmployeeMinutkaTransport {
  chat(input: ChatRequest) { return this.request("POST", `/v1/me/threads/${encodeURIComponent(input.threadId)}/messages`, { text: input.text, ...(input.inputModality ? { inputModality: input.inputModality } : {}) }); }
  openInvite(input: OpenInviteRequest) { return this.request("POST", "/v1/onboarding/invites/open", input); }
  acceptConsent(input: AcceptEmployeeConsentRequest) { return this.request("POST", "/v1/me/consent", input); }
  completeOnboarding(input: CompleteOnboardingRequest) { return this.request("POST", "/v1/me/onboarding", input); }
  getProfile() { return this.request("GET", "/v1/me/profile"); }
  listInsights(input: ListInsightsRequest) { const query = new URLSearchParams(); if (input.threadId) query.set("threadId", input.threadId); if (input.kind) query.set("kind", input.kind); return this.request("GET", `/v1/me/insights${query.size ? `?${query}` : ""}`); }
  submitFeedback(input: SubmitFeedbackRequest) { return this.request("POST", `/v1/me/threads/${encodeURIComponent(input.threadId)}/feedback`, { targetMessageId: input.targetMessageId, rating: input.rating, source: input.source }); }
  proposeTaskMutation(input: TaskMutationProposalRequest) { return this.request("POST", "/v1/me/task-mutations", input); }
  confirmTaskMutation(confirmationId: string, input: ConfirmTaskMutationRequest) { return this.request("POST", `/v1/me/task-mutations/${encodeURIComponent(confirmationId)}/confirm`, input); }
  proposeIdeaToTask(input: ProposeIdeaToTaskRequest) { return this.request("POST", "/v1/me/idea-task-conversions", input); }
  confirmIdeaToTask(confirmationId: string, input: ConfirmIdeaToTaskRequest) { return this.request("POST", `/v1/me/idea-task-conversions/${encodeURIComponent(confirmationId)}/confirm`, input); }
}

export class HttpAdminMinutkaTransport extends HttpTransportBase implements AdminMinutkaTransport {
  issueInvite(input: IssueInviteRequest) { return this.request("POST", "/v1/admin/invites", input); }
}

export class HttpServiceMinutkaTransport extends HttpTransportBase implements ServiceMinutkaTransport {
  redeemTelegramInvite(input: RedeemTelegramInviteRequest) { return this.request("POST", "/v1/service/telegram/invites/redeem", input); }
  forEmployee(employeeId: string): ServiceEmployeeMinutkaTransport { if (!employeeId) throw new Error("employeeId is required for service scope"); return new HttpServiceEmployeeMinutkaTransport({ ...this.options, employeeId }); }
}

class HttpServiceEmployeeMinutkaTransport extends HttpTransportBase implements ServiceEmployeeMinutkaTransport {
  private readonly prefix: string;
  constructor(options: HttpMinutkaTransportOptions & { employeeId: string }) { super(options); this.prefix = `/v1/service/employees/${encodeURIComponent(options.employeeId)}`; }
  chat(input: ServiceChatRequest) { return this.request("POST", `${this.prefix}/threads/${encodeURIComponent(input.threadId)}/messages`, { text: input.text, ...(input.inputModality ? { inputModality: input.inputModality } : {}), ...(input.responseChannel ? { responseChannel: input.responseChannel } : {}) }); }
  recordPrivacyExplanationShown() { return this.request("POST", `${this.prefix}/privacy-explanation`, {}); }
  acceptConsent(input: AcceptConsentRequest) { return this.request("POST", `${this.prefix}/consent`, input); }
  completeOnboarding(input: CompleteOnboardingRequest) { return this.request("POST", `${this.prefix}/onboarding`, input); }
  submitOnboardingAnswer(input: OnboardingAnswerRequest) { return this.request("POST", `${this.prefix}/onboarding/answers`, input); }
  confirmOnboarding() { return this.request("POST", `${this.prefix}/onboarding/confirm`, {}); }
  resetOnboardingDraft() { return this.request("POST", `${this.prefix}/onboarding/reset`, {}); }
  getProfile() { return this.request("GET", `${this.prefix}/profile`); }
  submitFeedback(input: SubmitFeedbackRequest) { return this.request("POST", `${this.prefix}/threads/${encodeURIComponent(input.threadId)}/feedback`, { targetMessageId: input.targetMessageId, rating: input.rating, source: input.source }); }
  proposeTaskMutation(input: TaskMutationProposalRequest) { return this.request("POST", `${this.prefix}/task-mutations`, input); }
  confirmTaskMutation(confirmationId: string, input: ConfirmTaskMutationRequest) { return this.request("POST", `${this.prefix}/task-mutations/${encodeURIComponent(confirmationId)}/confirm`, input); }
  proposeIdeaToTask(input: ProposeIdeaToTaskRequest) { return this.request("POST", `${this.prefix}/idea-task-conversions`, input); }
  confirmIdeaToTask(confirmationId: string, input: ConfirmIdeaToTaskRequest) { return this.request("POST", `${this.prefix}/idea-task-conversions/${encodeURIComponent(confirmationId)}/confirm`, input); }
}
