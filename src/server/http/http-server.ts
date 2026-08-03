import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import type { PersonalAssistantService } from "../../application/personal-assistant-service.js";
import {
  acceptConsentRequestSchema, acceptEmployeeConsentRequestSchema, adminUsageRequestSchema, chatRequestSchema, completeOnboardingRequestSchema, employeeIdSchema, serviceChatRequestSchema,
  issueInviteRequestSchema, listInsightsRequestSchema, onboardingAnswerRequestSchema, openInviteRequestSchema,
  taskMutationDecisionRequestSchema, ideaDeletionDecisionRequestSchema, recordPrivacyExplanationShownRequestSchema, redeemTelegramInviteRequestSchema,
  submitFeedbackRequestSchema, threadIdSchema, type ChatResponse,
} from "../../contracts/minutka-api.js";
import { authenticateBearer, type ApiAuthConfig, type AuthenticatedPrincipal } from "./auth.js";
import { RequestError, httpError, mapError, requestId } from "./error-mapping.js";
import { PersistenceError } from "../../application/persistence-error.js";
import { AssistantContextOverflowError } from "../../application/assistant-overflow-recovery.js";
import { AssistantMutationOutcomeUnknownError } from "../../application/assistant-mutation-outcome.js";
import { TokenBucketRateLimiter } from "./rate-limit.js";
import { assertAssistantTimeoutBudgets, productionAssistantTimeoutBudgets, type AssistantTimeoutBudgets } from "../../config/assistant-timeout-budgets.js";
import { toScheduleView } from "../../application/schedule-view.js";

export const bodyLimitBytes = 64 * 1024;
/** Chat may consume the full LLM budget; all other application handlers fail fast. */
export const chatHandlerTimeoutMs = productionAssistantTimeoutBudgets.httpChatHandlerMs;
export const serverRequestTimeoutMs = productionAssistantTimeoutBudgets.serverRequestMs;
export const defaultHandlerTimeoutMs = 15_000;
type Principal = AuthenticatedPrincipal;
type AccessLogEntry = { method: string; path: string; status: number; durationMs: number; requestId: string; principal?: Principal["kind"] };
type ErrorLogEntry = { method: string; path: string; requestId: string; error: { name: string; message: string; stack?: string } };
export type HttpApplicationService = Pick<PersonalAssistantService,
  | "issueInvite"
  | "listParticipants"
  | "getMonthlyUsage"
  | "openInvite"
  | "getProfile"
  | "acceptConsent"
  | "completeOnboarding"
  | "listInsights"
  | "submitFeedback"
  | "redeemTelegramInvite"
  | "recordPrivacyExplanationShown"
  | "submitOnboardingAnswer"
  | "confirmOnboarding"
  | "resetOnboardingDraft"
  | "resetConversation"
  | "listSchedules"
  | "chat"
  | "confirmTaskMutation"
  | "rejectTaskMutation"
  | "confirmIdeaDeletion"
  | "rejectIdeaDeletion"
  | "undoIdeaDeletion"
>;
export type HttpServerOptions = { application: HttpApplicationService; auth: ApiAuthConfig; host?: string; port?: number; allowNonLoopback?: boolean; trustProxy?: boolean; health?: () => Promise<boolean>; logger?: (entry: AccessLogEntry) => void; errorLogger?: (entry: ErrorLogEntry) => void; timeoutBudgets?: AssistantTimeoutBudgets };
export type RunningHttpServer = { url: string; close(): Promise<void>; server: Server };

function parse<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw httpError(400, "invalid_request", "Request validation failed."); return result.data; }
function objectBody(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) throw httpError(400, "invalid_request", "Request validation failed."); return value as Record<string, unknown>; }
async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) { const data = Buffer.from(chunk); size += data.length; if (size > bodyLimitBytes) throw httpError(413, "invalid_request", "Request body is too large."); chunks.push(data); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw httpError(400, "invalid_request", "Malformed JSON request body."); }
}
function query(url: URL): Record<string, string | undefined> { return Object.fromEntries(url.searchParams.entries()); }
function requirePrincipal(principal: Principal | undefined): Principal { if (!principal) throw httpError(401, "unauthorized", "Authentication is required."); return principal; }
function requireKind<K extends Principal["kind"]>(principal: Principal | undefined, kind: K): Extract<Principal, { kind: K }> { const authenticated = requirePrincipal(principal); if (authenticated.kind !== kind) throw httpError(403, "forbidden", "This operation is not permitted."); return authenticated as Extract<Principal, { kind: K }>; }
function send(res: ServerResponse, status: number, value: unknown, id: string): void { res.writeHead(status, { "content-type": "application/json; charset=utf-8", "x-request-id": id }); res.end(status === 204 ? undefined : JSON.stringify(value)); }
function publicChatResponse(result: Awaited<ReturnType<HttpApplicationService["chat"]>>): ChatResponse {
  return { messageId: result.messageId, response: result.response, selectedProcessIds: result.selectedProcessIds, ...(result.pendingAction ? { pendingAction: result.pendingAction } : {}), effect: result.effect };
}
function pathEmployee(pathname: string, suffix: string): string | undefined { const match = pathname.match(new RegExp(`^/v1/service/employees/([^/]+)${suffix}$`)); return match?.[1] ? decodeURIComponent(match[1]) : undefined; }
function mutationRateLimitKey(principal: Principal, pathname: string): string | undefined {
  if (principal.kind === "service") {
    const employee = pathname.match(/^\/v1\/service\/employees\/([^/]+)\//)?.[1];
    return employee ? `service-employee:${decodeURIComponent(employee)}` : undefined;
  }
  return `${principal.kind}:${principal.kind === "employee" ? principal.employeeId : principal.operatorId}`;
}
function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const first = typeof forwarded === "string" ? forwarded.split(",")[0]?.trim() : undefined;
    if (first) return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}
async function withHandlerTimeout<T>(timeoutMs: number, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action(controller.signal),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          const timeout = httpError(503, "internal_error", "Request timed out.");
          controller.abort(timeout);
          reject(timeout);
        }, timeoutMs);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
function serializeError(error: unknown): ErrorLogEntry["error"] {
  if (error instanceof Error) {
    // Retain the error type and frames for diagnosis without logging user input,
    // credentials, provider payloads, or other data embedded in error messages.
    const stack = error.stack?.split("\n").slice(1).join("\n");
    return { name: error.name, message: "[redacted]", ...(stack ? { stack } : {}) };
  }
  return { name: "UnknownError", message: "[redacted]" };
}
function isExpectedError(error: unknown): boolean { return error instanceof RequestError || error instanceof PersistenceError || error instanceof AssistantContextOverflowError || error instanceof AssistantMutationOutcomeUnknownError; }

export function createHttpServer(options: HttpServerOptions): Server {
  const timeoutBudgets = assertAssistantTimeoutBudgets(options.timeoutBudgets ?? productionAssistantTimeoutBudgets);
  const inviteLimiter = new TokenBucketRateLimiter(10, 10);
  const mutationLimiter = new TokenBucketRateLimiter(60, 60);
  const log = options.logger ?? ((entry: AccessLogEntry) => {
    console.info(`HTTP ${entry.method} ${entry.path} ${entry.status} ${entry.durationMs}ms ${entry.requestId}${entry.principal ? ` ${entry.principal}` : ""}`);
  });
  const logError = options.errorLogger ?? ((entry: ErrorLogEntry) => {
    console.error(`HTTP ${entry.method} ${entry.path} failed ${entry.requestId}`, entry.error);
  });
  const server = createServer(async (req, res) => {
    const id = requestId(); const started = Date.now(); const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const principal = authenticateBearer(req.headers.authorization, options.auth);
    let status = 500; let template = "<unmatched>";
    try {
      if (req.method === "GET" && url.pathname === "/healthz") { template = "/healthz"; const healthy = await (options.health?.() ?? Promise.resolve(true)); status = healthy ? 200 : 503; return send(res, status, { ok: healthy }, id); }
      if (!req.method) throw httpError(404, "invalid_request", "Route not found.");
      const mutable = req.method !== "GET";
      const mutationKey = mutable && principal ? mutationRateLimitKey(principal, url.pathname) : undefined;
      if (mutationKey && !mutationLimiter.allow(mutationKey)) throw httpError(429, "rate_limited", "Too many requests.");

      if (req.method === "POST" && url.pathname === "/v1/admin/invites") { template = "/v1/admin/invites"; requireKind(principal, "operator"); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.application.issueInvite(parse(issueInviteRequestSchema, await body(req)))), id); }
      if (req.method === "GET" && url.pathname === "/v1/admin/participants") { template = "/v1/admin/participants"; requireKind(principal, "operator"); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.application.listParticipants()), id); }
      const adminUsage = url.pathname.match(/^\/v1\/admin\/employees\/([^/]+)\/usage$/);
      if (req.method === "GET" && adminUsage) {
        template = "/v1/admin/employees/:employeeId/usage";
        requireKind(principal, "operator");
        const input = parse(adminUsageRequestSchema, { employeeId: decodeURIComponent(adminUsage[1]), month: url.searchParams.get("month") });
        status = 200;
        return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.application.getMonthlyUsage(input.employeeId, input.month)), id);
      }
      if (req.method === "POST" && url.pathname === "/v1/onboarding/invites/open") { template = "/v1/onboarding/invites/open"; if (!inviteLimiter.allow(clientIp(req, options.trustProxy === true))) throw httpError(429, "rate_limited", "Too many requests."); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.application.openInvite(parse(openInviteRequestSchema, await body(req)))), id); }

      if (req.method === "GET" && url.pathname === "/v1/me/profile") { template = "/v1/me/profile"; const employee = requireKind(principal, "employee"); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.application.getProfile({ employeeId: employee.employeeId })), id); }
      if (req.method === "POST" && url.pathname === "/v1/me/consent") { template = "/v1/me/consent"; const employee = requireKind(principal, "employee"); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.application.acceptConsent({ ...parse(acceptEmployeeConsentRequestSchema, await body(req)), employeeId: employee.employeeId })), id); }
      if (req.method === "POST" && url.pathname === "/v1/me/onboarding") { template = "/v1/me/onboarding"; const employee = requireKind(principal, "employee"); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.application.completeOnboarding({ ...parse(completeOnboardingRequestSchema, await body(req)), employeeId: employee.employeeId })), id); }
      if (req.method === "GET" && url.pathname === "/v1/me/insights") { template = "/v1/me/insights"; const employee = requireKind(principal, "employee"); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.application.listInsights({ ...parse(listInsightsRequestSchema, query(url)), employeeId: employee.employeeId })), id); }
      const meTaskDecision = url.pathname.match(/^\/v1\/me\/task-mutations\/([^/]+)\/(confirm|reject)$/);
      if (req.method === "POST" && meTaskDecision) {
        const employee = requireKind(principal, "employee");
        parse(taskMutationDecisionRequestSchema, await body(req));
        const confirmationId = decodeURIComponent(meTaskDecision[1]);
        const decision = meTaskDecision[2];
        template = `/v1/me/task-mutations/:confirmationId/${decision}`;
        status = 200;
        return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => decision === "confirm"
          ? options.application.confirmTaskMutation(employee.employeeId, confirmationId)
          : options.application.rejectTaskMutation(employee.employeeId, confirmationId)), id);
      }
      const meIdeaDeletionDecision = url.pathname.match(/^\/v1\/me\/idea-deletions\/([^/]+)\/(confirm|reject)$/);
      if (req.method === "POST" && meIdeaDeletionDecision) {
        const employee = requireKind(principal, "employee");
        parse(ideaDeletionDecisionRequestSchema, await body(req));
        const confirmationId = decodeURIComponent(meIdeaDeletionDecision[1]);
        const decision = meIdeaDeletionDecision[2];
        template = `/v1/me/idea-deletions/:confirmationId/${decision}`;
        status = 200;
        return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => decision === "confirm"
          ? options.application.confirmIdeaDeletion(employee.employeeId, confirmationId)
          : options.application.rejectIdeaDeletion(employee.employeeId, confirmationId)), id);
      }
      const meIdeaUndo = url.pathname.match(/^\/v1\/me\/ideas(?:\/([^/]+))?\/undo$/);
      if (req.method === "POST" && meIdeaUndo) {
        const employee = requireKind(principal, "employee");
        parse(ideaDeletionDecisionRequestSchema, await body(req));
        template = "/v1/me/ideas/:ideaId?/undo";
        status = 200;
        return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.application.undoIdeaDeletion(employee.employeeId, meIdeaUndo[1] ? decodeURIComponent(meIdeaUndo[1]) : undefined)), id);
      }
      const meMessage = url.pathname.match(/^\/v1\/me\/threads\/([^/]+)\/messages$/);
      if (req.method === "POST" && meMessage) { template = "/v1/me/threads/:threadId/messages"; const employee = requireKind(principal, "employee"); const input = parse(chatRequestSchema, { ...objectBody(await body(req)), threadId: parse(threadIdSchema, decodeURIComponent(meMessage[1])) }); status = 200; return send(res, status, await withHandlerTimeout(timeoutBudgets.httpChatHandlerMs, async (signal) => publicChatResponse(await options.application.chat({ userId: employee.employeeId, threadId: input.threadId, text: input.text, inputModality: input.inputModality, signal }))), id); }
      const meFeedback = url.pathname.match(/^\/v1\/me\/threads\/([^/]+)\/feedback$/);
      if (req.method === "POST" && meFeedback) { template = "/v1/me/threads/:threadId/feedback"; const employee = requireKind(principal, "employee"); const input = parse(submitFeedbackRequestSchema, { ...objectBody(await body(req)), threadId: parse(threadIdSchema, decodeURIComponent(meFeedback[1])) }); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.application.submitFeedback({ ...input, employeeId: employee.employeeId })), id); }

      if (req.method === "POST" && url.pathname === "/v1/service/telegram/invites/redeem") { template = "/v1/service/telegram/invites/redeem"; requireKind(principal, "service"); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.application.redeemTelegramInvite(parse(redeemTelegramInviteRequestSchema, await body(req)))), id); }
      const serviceEmployee = pathEmployee(url.pathname, "/privacy-explanation");
      if (req.method === "POST" && serviceEmployee) { template = "/v1/service/employees/:employeeId/privacy-explanation"; requireKind(principal, "service"); parse(z.strictObject({}), await body(req)); parse(recordPrivacyExplanationShownRequestSchema, { employeeId: parse(employeeIdSchema, serviceEmployee) }); await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.application.recordPrivacyExplanationShown({ employeeId: serviceEmployee })); status = 204; return send(res, status, undefined, id); }
      const serviceProfile = pathEmployee(url.pathname, "/profile");
      if (req.method === "GET" && serviceProfile) { template = "/v1/service/employees/:employeeId/profile"; requireKind(principal, "service"); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.application.getProfile({ employeeId: parse(employeeIdSchema, serviceProfile) })), id); }
      const serviceConversationReset = pathEmployee(url.pathname, "/conversation/reset");
      if (req.method === "POST" && serviceConversationReset) { template = "/v1/service/employees/:employeeId/conversation/reset"; requireKind(principal, "service"); parse(z.strictObject({}), await body(req)); await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.application.resetConversation({ userId: parse(employeeIdSchema, serviceConversationReset) })); status = 204; return send(res, status, undefined, id); }
      const serviceSchedules = pathEmployee(url.pathname, "/schedules");
      if (req.method === "GET" && serviceSchedules) { template = "/v1/service/employees/:employeeId/schedules"; requireKind(principal, "service"); status = 200; return send(res, status, { schedules: (await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.application.listSchedules(parse(employeeIdSchema, serviceSchedules)))).map(toScheduleView) }, id); }
      const serviceConsent = pathEmployee(url.pathname, "/consent");
      if (req.method === "POST" && serviceConsent) { template = "/v1/service/employees/:employeeId/consent"; requireKind(principal, "service"); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.application.acceptConsent({ ...parse(acceptConsentRequestSchema, await body(req)), employeeId: parse(employeeIdSchema, serviceConsent) })), id); }
      const serviceOnboardingAnswer = pathEmployee(url.pathname, "/onboarding/answers");
      if (req.method === "POST" && serviceOnboardingAnswer) { template = "/v1/service/employees/:employeeId/onboarding/answers"; requireKind(principal, "service"); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.application.submitOnboardingAnswer({ ...parse(onboardingAnswerRequestSchema, await body(req)), employeeId: parse(employeeIdSchema, serviceOnboardingAnswer) })), id); }
      const serviceOnboardingConfirm = pathEmployee(url.pathname, "/onboarding/confirm");
      if (req.method === "POST" && serviceOnboardingConfirm) { template = "/v1/service/employees/:employeeId/onboarding/confirm"; requireKind(principal, "service"); parse(z.strictObject({}), await body(req)); status = 200; return send(res, status, await withHandlerTimeout(chatHandlerTimeoutMs, async () => options.application.confirmOnboarding({ employeeId: parse(employeeIdSchema, serviceOnboardingConfirm) })), id); }
      const serviceOnboardingReset = pathEmployee(url.pathname, "/onboarding/reset");
      if (req.method === "POST" && serviceOnboardingReset) { template = "/v1/service/employees/:employeeId/onboarding/reset"; requireKind(principal, "service"); parse(z.strictObject({}), await body(req)); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.application.resetOnboardingDraft({ employeeId: parse(employeeIdSchema, serviceOnboardingReset) })), id); }
      const serviceOnboarding = pathEmployee(url.pathname, "/onboarding");
      if (req.method === "POST" && serviceOnboarding) { template = "/v1/service/employees/:employeeId/onboarding"; requireKind(principal, "service"); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.application.completeOnboarding({ ...parse(completeOnboardingRequestSchema, await body(req)), employeeId: parse(employeeIdSchema, serviceOnboarding) })), id); }
      const serviceTaskDecision = url.pathname.match(/^\/v1\/service\/employees\/([^/]+)\/task-mutations\/([^/]+)\/(confirm|reject)$/);
      if (req.method === "POST" && serviceTaskDecision) {
        requireKind(principal, "service");
        parse(taskMutationDecisionRequestSchema, await body(req));
        const employeeId = parse(employeeIdSchema, decodeURIComponent(serviceTaskDecision[1]));
        const confirmationId = decodeURIComponent(serviceTaskDecision[2]);
        const decision = serviceTaskDecision[3];
        template = `/v1/service/employees/:employeeId/task-mutations/:confirmationId/${decision}`;
        status = 200;
        return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => decision === "confirm"
          ? options.application.confirmTaskMutation(employeeId, confirmationId)
          : options.application.rejectTaskMutation(employeeId, confirmationId)), id);
      }
      const serviceIdeaDeletionDecision = url.pathname.match(/^\/v1\/service\/employees\/([^/]+)\/idea-deletions\/([^/]+)\/(confirm|reject)$/);
      if (req.method === "POST" && serviceIdeaDeletionDecision) {
        requireKind(principal, "service");
        parse(ideaDeletionDecisionRequestSchema, await body(req));
        const employeeId = parse(employeeIdSchema, decodeURIComponent(serviceIdeaDeletionDecision[1]));
        const confirmationId = decodeURIComponent(serviceIdeaDeletionDecision[2]);
        const decision = serviceIdeaDeletionDecision[3];
        template = `/v1/service/employees/:employeeId/idea-deletions/:confirmationId/${decision}`;
        status = 200;
        return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => decision === "confirm"
          ? options.application.confirmIdeaDeletion(employeeId, confirmationId)
          : options.application.rejectIdeaDeletion(employeeId, confirmationId)), id);
      }
      const serviceIdeaUndo = url.pathname.match(/^\/v1\/service\/employees\/([^/]+)\/ideas(?:\/([^/]+))?\/undo$/);
      if (req.method === "POST" && serviceIdeaUndo) {
        requireKind(principal, "service");
        parse(ideaDeletionDecisionRequestSchema, await body(req));
        const employeeId = parse(employeeIdSchema, decodeURIComponent(serviceIdeaUndo[1]));
        template = "/v1/service/employees/:employeeId/ideas/:ideaId?/undo";
        status = 200;
        return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.application.undoIdeaDeletion(employeeId, serviceIdeaUndo[2] ? decodeURIComponent(serviceIdeaUndo[2]) : undefined)), id);
      }
      const serviceMessage = url.pathname.match(/^\/v1\/service\/employees\/([^/]+)\/threads\/([^/]+)\/messages$/);
      if (req.method === "POST" && serviceMessage) { template = "/v1/service/employees/:employeeId/threads/:threadId/messages"; requireKind(principal, "service"); const input = parse(serviceChatRequestSchema, { ...objectBody(await body(req)), threadId: decodeURIComponent(serviceMessage[2]) }); const employeeId = parse(employeeIdSchema, decodeURIComponent(serviceMessage[1])); status = 200; return send(res, status, await withHandlerTimeout(timeoutBudgets.httpChatHandlerMs, async (signal) => publicChatResponse(await options.application.chat({ userId: employeeId, threadId: input.threadId, text: input.text, inputModality: input.inputModality, responseChannel: input.responseChannel, signal }))), id); }
      const serviceFeedback = url.pathname.match(/^\/v1\/service\/employees\/([^/]+)\/threads\/([^/]+)\/feedback$/);
      if (req.method === "POST" && serviceFeedback) { template = "/v1/service/employees/:employeeId/threads/:threadId/feedback"; requireKind(principal, "service"); const input = parse(submitFeedbackRequestSchema, { ...objectBody(await body(req)), threadId: decodeURIComponent(serviceFeedback[2]) }); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.application.submitFeedback({ ...input, employeeId: parse(employeeIdSchema, decodeURIComponent(serviceFeedback[1])) })), id); }
      throw httpError(404, "invalid_request", "Route not found.");
    } catch (error) {
      if (!isExpectedError(error)) logError({ method: req.method ?? "UNKNOWN", path: template, requestId: id, error: serializeError(error) });
      const mapped = mapError(error); status = mapped.status; return send(res, status, { error: { code: mapped.code, message: mapped.message, requestId: id } }, id);
    } finally { log({ method: req.method ?? "UNKNOWN", path: template, status, durationMs: Date.now() - started, requestId: id, ...(principal ? { principal: principal.kind } : {}) }); }
  });
  server.headersTimeout = 15_000; server.requestTimeout = timeoutBudgets.serverRequestMs;
  return server;
}
export async function listenHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const host = options.host?.trim() || "127.0.0.1";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (!loopbackHosts.has(host) && !options.allowNonLoopback) throw new Error("non-loopback HTTP bind requires MINUTKA_API_ALLOW_NON_LOOPBACK=true and a TLS reverse proxy");
  if (!loopbackHosts.has(host) && !options.trustProxy) throw new Error("non-loopback HTTP bind requires MINUTKA_API_TRUST_PROXY=true behind a trusted TLS reverse proxy");
  const server = createHttpServer(options); await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 8787, host, () => { server.off("error", reject); resolve(); }); });
  const address = server.address() as AddressInfo; const urlHost = host.includes(":") ? `[${host}]` : host;
  return { server, url: `http://${urlHost}:${address.port}`, close: () => {
    server.closeIdleConnections();
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}
