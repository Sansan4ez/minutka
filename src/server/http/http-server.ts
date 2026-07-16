import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import type { AssistantService } from "../../application/assistant-service.js";
import type { MinutkaService } from "../../application/minutka-service.js";
import type { PersonalAssistantService } from "../../application/personal-assistant-service.js";
import {
  acceptConsentRequestSchema, acceptEmployeeConsentRequestSchema, chatRequestSchema, completeOnboardingRequestSchema, employeeIdSchema,
  issueInviteRequestSchema, listInsightsRequestSchema, onboardingAnswerRequestSchema, openInviteRequestSchema,
  recordPrivacyExplanationShownRequestSchema, redeemTelegramInviteRequestSchema,
  submitFeedbackRequestSchema, threadIdSchema, type ChatResponse,
} from "../../contracts/minutka-api.js";
import { authenticateBearer, type ApiAuthConfig, type AuthenticatedPrincipal } from "./auth.js";
import { RequestError, httpError, mapError, requestId } from "./error-mapping.js";
import { PersistenceError } from "../../application/persistence-error.js";
import { TokenBucketRateLimiter } from "./rate-limit.js";

export const bodyLimitBytes = 64 * 1024;
/** Chat may consume the full LLM budget; all other application handlers fail fast. */
export const chatHandlerTimeoutMs = 120_000;
export const defaultHandlerTimeoutMs = 15_000;
type Principal = AuthenticatedPrincipal;
type AccessLogEntry = { method: string; path: string; status: number; durationMs: number; requestId: string; principal?: Principal["kind"] };
type ErrorLogEntry = { method: string; path: string; requestId: string; error: { name: string; message: string; stack?: string } };
type HttpIdentityService = Pick<MinutkaService,
  | "issueInvite"
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
> | Pick<PersonalAssistantService,
  | "issueInvite"
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
>;
export type HttpServerOptions = { service: HttpIdentityService; assistant: Pick<AssistantService, "chat"> | Pick<PersonalAssistantService, "chat">; auth: ApiAuthConfig; host?: string; port?: number; allowNonLoopback?: boolean; trustProxy?: boolean; health?: () => Promise<boolean>; logger?: (entry: AccessLogEntry) => void; errorLogger?: (entry: ErrorLogEntry) => void };
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
function publicChatResponse(result: Awaited<ReturnType<AssistantService["chat"]>> | Awaited<ReturnType<PersonalAssistantService["chat"]>>): ChatResponse {
  return { messageId: result.messageId, response: result.response, selectedProcessIds: result.selectedProcessIds };
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
async function withHandlerTimeout<T>(timeoutMs: number, action: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action(),
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(httpError(503, "internal_error", "Request timed out.")), timeoutMs); }),
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
function isExpectedError(error: unknown): boolean { return error instanceof RequestError || error instanceof PersistenceError; }

export function createHttpServer(options: HttpServerOptions): Server {
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

      if (req.method === "POST" && url.pathname === "/v1/admin/invites") { template = "/v1/admin/invites"; requireKind(principal, "operator"); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.service.issueInvite(parse(issueInviteRequestSchema, await body(req)))), id); }
      if (req.method === "POST" && url.pathname === "/v1/onboarding/invites/open") { template = "/v1/onboarding/invites/open"; if (!inviteLimiter.allow(clientIp(req, options.trustProxy === true))) throw httpError(429, "rate_limited", "Too many requests."); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.service.openInvite(parse(openInviteRequestSchema, await body(req)))), id); }

      if (req.method === "GET" && url.pathname === "/v1/me/profile") { template = "/v1/me/profile"; const employee = requireKind(principal, "employee"); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.service.getProfile({ employeeId: employee.employeeId })), id); }
      if (req.method === "POST" && url.pathname === "/v1/me/consent") { template = "/v1/me/consent"; const employee = requireKind(principal, "employee"); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.service.acceptConsent({ ...parse(acceptEmployeeConsentRequestSchema, await body(req)), employeeId: employee.employeeId })), id); }
      if (req.method === "POST" && url.pathname === "/v1/me/onboarding") { template = "/v1/me/onboarding"; const employee = requireKind(principal, "employee"); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.service.completeOnboarding({ ...parse(completeOnboardingRequestSchema, await body(req)), employeeId: employee.employeeId })), id); }
      if (req.method === "GET" && url.pathname === "/v1/me/insights") { template = "/v1/me/insights"; const employee = requireKind(principal, "employee"); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.service.listInsights({ ...parse(listInsightsRequestSchema, query(url)), employeeId: employee.employeeId })), id); }
      const meMessage = url.pathname.match(/^\/v1\/me\/threads\/([^/]+)\/messages$/);
      if (req.method === "POST" && meMessage) { template = "/v1/me/threads/:threadId/messages"; const employee = requireKind(principal, "employee"); const input = parse(chatRequestSchema, { ...objectBody(await body(req)), threadId: parse(threadIdSchema, decodeURIComponent(meMessage[1])) }); status = 200; return send(res, status, await withHandlerTimeout(chatHandlerTimeoutMs, async () => publicChatResponse(await options.assistant.chat({ userId: employee.employeeId, threadId: input.threadId, text: input.text, inputModality: input.inputModality }))), id); }
      const meFeedback = url.pathname.match(/^\/v1\/me\/threads\/([^/]+)\/feedback$/);
      if (req.method === "POST" && meFeedback) { template = "/v1/me/threads/:threadId/feedback"; const employee = requireKind(principal, "employee"); const input = parse(submitFeedbackRequestSchema, { ...objectBody(await body(req)), threadId: parse(threadIdSchema, decodeURIComponent(meFeedback[1])) }); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.service.submitFeedback({ ...input, employeeId: employee.employeeId })), id); }

      if (req.method === "POST" && url.pathname === "/v1/service/telegram/invites/redeem") { template = "/v1/service/telegram/invites/redeem"; requireKind(principal, "service"); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.service.redeemTelegramInvite(parse(redeemTelegramInviteRequestSchema, await body(req)))), id); }
      const serviceEmployee = pathEmployee(url.pathname, "/privacy-explanation");
      if (req.method === "POST" && serviceEmployee) { template = "/v1/service/employees/:employeeId/privacy-explanation"; requireKind(principal, "service"); parse(z.strictObject({}), await body(req)); parse(recordPrivacyExplanationShownRequestSchema, { employeeId: parse(employeeIdSchema, serviceEmployee) }); await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.service.recordPrivacyExplanationShown({ employeeId: serviceEmployee })); status = 204; return send(res, status, undefined, id); }
      const serviceProfile = pathEmployee(url.pathname, "/profile");
      if (req.method === "GET" && serviceProfile) { template = "/v1/service/employees/:employeeId/profile"; requireKind(principal, "service"); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.service.getProfile({ employeeId: parse(employeeIdSchema, serviceProfile) })), id); }
      const serviceConsent = pathEmployee(url.pathname, "/consent");
      if (req.method === "POST" && serviceConsent) { template = "/v1/service/employees/:employeeId/consent"; requireKind(principal, "service"); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.service.acceptConsent({ ...parse(acceptConsentRequestSchema, await body(req)), employeeId: parse(employeeIdSchema, serviceConsent) })), id); }
      const serviceOnboardingAnswer = pathEmployee(url.pathname, "/onboarding/answers");
      if (req.method === "POST" && serviceOnboardingAnswer) { template = "/v1/service/employees/:employeeId/onboarding/answers"; requireKind(principal, "service"); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.service.submitOnboardingAnswer({ ...parse(onboardingAnswerRequestSchema, await body(req)), employeeId: parse(employeeIdSchema, serviceOnboardingAnswer) })), id); }
      const serviceOnboardingConfirm = pathEmployee(url.pathname, "/onboarding/confirm");
      if (req.method === "POST" && serviceOnboardingConfirm) { template = "/v1/service/employees/:employeeId/onboarding/confirm"; requireKind(principal, "service"); parse(z.strictObject({}), await body(req)); status = 200; return send(res, status, await withHandlerTimeout(chatHandlerTimeoutMs, async () => options.service.confirmOnboarding({ employeeId: parse(employeeIdSchema, serviceOnboardingConfirm) })), id); }
      const serviceOnboardingReset = pathEmployee(url.pathname, "/onboarding/reset");
      if (req.method === "POST" && serviceOnboardingReset) { template = "/v1/service/employees/:employeeId/onboarding/reset"; requireKind(principal, "service"); parse(z.strictObject({}), await body(req)); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.service.resetOnboardingDraft({ employeeId: parse(employeeIdSchema, serviceOnboardingReset) })), id); }
      const serviceOnboarding = pathEmployee(url.pathname, "/onboarding");
      if (req.method === "POST" && serviceOnboarding) { template = "/v1/service/employees/:employeeId/onboarding"; requireKind(principal, "service"); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.service.completeOnboarding({ ...parse(completeOnboardingRequestSchema, await body(req)), employeeId: parse(employeeIdSchema, serviceOnboarding) })), id); }
      const serviceMessage = url.pathname.match(/^\/v1\/service\/employees\/([^/]+)\/threads\/([^/]+)\/messages$/);
      if (req.method === "POST" && serviceMessage) { template = "/v1/service/employees/:employeeId/threads/:threadId/messages"; requireKind(principal, "service"); const input = parse(chatRequestSchema, { ...objectBody(await body(req)), threadId: decodeURIComponent(serviceMessage[2]) }); const employeeId = parse(employeeIdSchema, decodeURIComponent(serviceMessage[1])); status = 200; return send(res, status, await withHandlerTimeout(chatHandlerTimeoutMs, async () => publicChatResponse(await options.assistant.chat({ userId: employeeId, threadId: input.threadId, text: input.text, inputModality: input.inputModality }))), id); }
      const serviceFeedback = url.pathname.match(/^\/v1\/service\/employees\/([^/]+)\/threads\/([^/]+)\/feedback$/);
      if (req.method === "POST" && serviceFeedback) { template = "/v1/service/employees/:employeeId/threads/:threadId/feedback"; requireKind(principal, "service"); const input = parse(submitFeedbackRequestSchema, { ...objectBody(await body(req)), threadId: decodeURIComponent(serviceFeedback[2]) }); status = 200; return send(res, status, await withHandlerTimeout(defaultHandlerTimeoutMs, async () => options.service.submitFeedback({ ...input, employeeId: parse(employeeIdSchema, decodeURIComponent(serviceFeedback[1])) })), id); }
      throw httpError(404, "invalid_request", "Route not found.");
    } catch (error) {
      if (!isExpectedError(error)) logError({ method: req.method ?? "UNKNOWN", path: template, requestId: id, error: serializeError(error) });
      const mapped = mapError(error); status = mapped.status; return send(res, status, { error: { code: mapped.code, message: mapped.message, requestId: id } }, id);
    } finally { log({ method: req.method ?? "UNKNOWN", path: template, status, durationMs: Date.now() - started, requestId: id, ...(principal ? { principal: principal.kind } : {}) }); }
  });
  server.headersTimeout = 15_000; server.requestTimeout = 120_000;
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
