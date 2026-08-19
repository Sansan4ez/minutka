import {
  errorEnvelopeSchema,
  type AcceptConsentRequest, type AcceptEmployeeConsentRequest, type AdminUsageRequest, type ChatRequest, type CompanyReportRequest, type ContextDocumentVersionsRequest,
  type CompleteOnboardingRequest, type IssueInviteRequest, type ServiceChatRequest, type ListInsightsRequest,
  type OnboardingAnswerRequest, type OpenInviteRequest, type RedeemTelegramInviteRequest, type RestoreContextDocumentVersionRequest, type SubmitFeedbackRequest, type TaskMutationDecisionRequest, type ContextDocumentDecisionRequest, type ListParticipantsRequest,
} from "../../contracts/minutka-api.js";
import type {
  AdminMinutkaTransport, EmployeeMinutkaTransport, ServiceEmployeeMinutkaTransport,
  ServiceMinutkaTransport,
} from "./minutka-client.js";
import { productionAssistantTimeoutBudgets } from "../../config/assistant-timeout-budgets.js";

export class MinutkaApiError extends Error {
  constructor(readonly code: string, readonly requestId?: string, message = "API request failed") { super(message); this.name = "MinutkaApiError"; }
}
export type HttpMinutkaTransportOptions = { baseUrl: string; token: string; timeoutMs?: number; employeeId?: string };

class HttpTransportBase {
  protected readonly baseUrl: string;
  protected readonly timeoutMs: number;
  constructor(protected readonly options: HttpMinutkaTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, ""); this.timeoutMs = options.timeoutMs ?? productionAssistantTimeoutBudgets.sdkTransportMs;
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
  confirmTaskMutation(confirmationId: string, input: TaskMutationDecisionRequest) { return this.request("POST", `/v1/me/task-mutations/${encodeURIComponent(confirmationId)}/confirm`, input); }
  rejectTaskMutation(confirmationId: string, input: TaskMutationDecisionRequest) { return this.request("POST", `/v1/me/task-mutations/${encodeURIComponent(confirmationId)}/reject`, input); }
  confirmContextDocumentMutation(confirmationId: string, input: ContextDocumentDecisionRequest) { return this.request("POST", `/v1/me/context-document-mutations/${encodeURIComponent(confirmationId)}/confirm`, input); }
  rejectContextDocumentMutation(confirmationId: string, input: ContextDocumentDecisionRequest) { return this.request("POST", `/v1/me/context-document-mutations/${encodeURIComponent(confirmationId)}/reject`, input); }
  confirmIdeaDeletion(confirmationId: string) { return this.request("POST", `/v1/me/idea-deletions/${encodeURIComponent(confirmationId)}/confirm`, {}); }
  rejectIdeaDeletion(confirmationId: string) { return this.request("POST", `/v1/me/idea-deletions/${encodeURIComponent(confirmationId)}/reject`, {}); }
  undoIdeaDeletion(ideaId?: string) { return this.request("POST", ideaId ? `/v1/me/ideas/${encodeURIComponent(ideaId)}/undo` : "/v1/me/ideas/undo", {}); }
}

export class HttpAdminMinutkaTransport extends HttpTransportBase implements AdminMinutkaTransport {
  issueInvite(input: IssueInviteRequest) { return this.request("POST", "/v1/admin/invites", input); }
  listParticipants(input: ListParticipantsRequest) {
    const query = new URLSearchParams({ companyId: input.companyId, groupId: input.groupId, limit: String(input.limit) });
    if (input.after) query.set("after", input.after);
    return this.request("GET", `/v1/admin/participants?${query}`);
  }
  getMonthlyUsage(input: AdminUsageRequest) { return this.request("GET", `/v1/admin/employees/${encodeURIComponent(input.employeeId)}/usage?month=${encodeURIComponent(input.month)}`); }
  exportCompanyReport(input: CompanyReportRequest) {
    const query = new URLSearchParams({ groupId: input.groupId });
    return this.request("GET", `/v1/admin/companies/${encodeURIComponent(input.companyId)}/report?${query}`);
  }
  listContextDocumentVersions(input: ContextDocumentVersionsRequest) {
    const query = new URLSearchParams({ path: input.path, limit: String(input.limit) });
    return this.request("GET", `/v1/admin/employees/${encodeURIComponent(input.employeeId)}/context-documents/versions?${query}`);
  }
  restoreContextDocumentVersion(input: RestoreContextDocumentVersionRequest) {
    return this.request("POST", `/v1/admin/employees/${encodeURIComponent(input.employeeId)}/context-documents/restore`, { path: input.path, version: input.version });
  }
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
  getOnboardingProgress() { return this.request("GET", `${this.prefix}/onboarding/progress`); }
  submitOnboardingAnswer(input: OnboardingAnswerRequest) { return this.request("POST", `${this.prefix}/onboarding/answers`, input); }
  confirmOnboarding() { return this.request("POST", `${this.prefix}/onboarding/confirm`, {}); }
  resetOnboardingDraft() { return this.request("POST", `${this.prefix}/onboarding/reset`, {}); }
  getProfile() { return this.request("GET", `${this.prefix}/profile`); }
  resetConversation() { return this.request("POST", `${this.prefix}/conversation/reset`, {}); }
  listSchedules() { return this.request("GET", `${this.prefix}/schedules`); }
  submitFeedback(input: SubmitFeedbackRequest) { return this.request("POST", `${this.prefix}/threads/${encodeURIComponent(input.threadId)}/feedback`, { targetMessageId: input.targetMessageId, rating: input.rating, source: input.source }); }
  confirmTaskMutation(confirmationId: string, input: TaskMutationDecisionRequest) { return this.request("POST", `${this.prefix}/task-mutations/${encodeURIComponent(confirmationId)}/confirm`, input); }
  rejectTaskMutation(confirmationId: string, input: TaskMutationDecisionRequest) { return this.request("POST", `${this.prefix}/task-mutations/${encodeURIComponent(confirmationId)}/reject`, input); }
  confirmContextDocumentMutation(confirmationId: string, input: ContextDocumentDecisionRequest) { return this.request("POST", `${this.prefix}/context-document-mutations/${encodeURIComponent(confirmationId)}/confirm`, input); }
  rejectContextDocumentMutation(confirmationId: string, input: ContextDocumentDecisionRequest) { return this.request("POST", `${this.prefix}/context-document-mutations/${encodeURIComponent(confirmationId)}/reject`, input); }
  confirmIdeaDeletion(confirmationId: string) { return this.request("POST", `${this.prefix}/idea-deletions/${encodeURIComponent(confirmationId)}/confirm`, {}); }
  rejectIdeaDeletion(confirmationId: string) { return this.request("POST", `${this.prefix}/idea-deletions/${encodeURIComponent(confirmationId)}/reject`, {}); }
  undoIdeaDeletion(ideaId?: string) { return this.request("POST", ideaId ? `${this.prefix}/ideas/${encodeURIComponent(ideaId)}/undo` : `${this.prefix}/ideas/undo`, {}); }
}
