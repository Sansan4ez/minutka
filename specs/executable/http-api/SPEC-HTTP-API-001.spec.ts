import { afterEach, describe, expect, it } from "vitest";
import { createInMemoryRuntime, executableSpecPrivacyExplanation } from "../../../src/runtime/create-in-memory-runtime.js";
import { chatHandlerTimeoutMs, defaultHandlerTimeoutMs, listenHttpServer, serverRequestTimeoutMs, type RunningHttpServer } from "../../../src/server/http/http-server.js";
import { apiAuthConfigFromEnv } from "../../../src/server/http/auth.js";
import { PersistenceError } from "../../../src/application/persistence-error.js";
import { mapError } from "../../../src/server/http/error-mapping.js";
import { ServiceMinutkaClient } from "../../../src/client/sdk/minutka-client.js";
import { HttpServiceMinutkaTransport } from "../../../src/client/sdk/http-transport.js";
import { createTelegramShell } from "../../../src/telegram/telegram-shell.js";
import { createDefaultSpecDeps } from "../support/scripted-deps.js";
import { chatResponseSchema } from "../../../src/contracts/minutka-api.js";
import { createSpecHttpApplication } from "../support/assistant-chat-adapter.js";
import { assertAssistantTimeoutBudgets, productionAssistantTimeoutBudgets } from "../../../src/config/assistant-timeout-budgets.js";
import { ScheduleManagementService } from "../../../src/application/schedule-management-service.js";

const employeeToken = "a".repeat(64); const otherToken = "b".repeat(64); const serviceToken = "c".repeat(64); const adminToken = "d".repeat(64);
const running: RunningHttpServer[] = [];
afterEach(async () => { await Promise.all(running.splice(0).map((server) => server.close())); });

async function api() {
  const runtime = createInMemoryRuntime({ agentRunner: async () => "response", deps: createDefaultSpecDeps() });
  await runtime.service.issueInvite({ employeeId: "emp_a", inviteCode: "invite_a", companyId: "default_company", groupId: "default_group" });
  await runtime.service.issueInvite({ employeeId: "emp_b", inviteCode: "invite_b", companyId: "default_company", groupId: "default_group" });
  const server = await listenHttpServer({ application: createSpecHttpApplication(runtime.service), port: 0, logger: () => undefined, auth: { serviceToken, adminToken, employeeTokens: new Map([["emp_a", employeeToken], ["emp_b", otherToken]]) } });
  running.push(server); return { runtime, url: server.url };
}
async function request(url: string, path: string, token?: string, init: RequestInit = {}) {
  return fetch(`${url}${path}`, { ...init, headers: { ...(init.headers ?? {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } });
}

describe("SPEC-HTTP-API-001: authenticated HTTP application API", () => {
  it("rejects unauthenticated, cross-plane, and unknown employee fields before the service", async () => {
    const { url, runtime } = await api();
    let profileCalls = 0;
    const getProfile = runtime.service.getProfile.bind(runtime.service);
    runtime.service.getProfile = async (input) => { profileCalls += 1; return getProfile(input); };
    const unauthenticated = await request(url, "/v1/me/profile");
    expect(unauthenticated.status).toBe(401); expect((await unauthenticated.json()).error).toMatchObject({ code: "unauthorized" }); expect(profileCalls).toBe(0);
    const serviceInsights = await request(url, "/v1/me/insights", serviceToken);
    expect(serviceInsights.status).toBe(403); expect(profileCalls).toBe(0);
    const forbidden = await request(url, "/v1/admin/invites", employeeToken, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ employeeId: "emp_b", inviteCode: "new" }) });
    expect(forbidden.status).toBe(403);
    const strict = await request(url, "/v1/me/consent", employeeToken, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accepted: true, source: "cli", employeeId: "emp_b", telegramIdentity: { chatId: "attacker-chat" } }) });
    expect(strict.status).toBe(400); const payload = await strict.json(); expect(payload.error).toMatchObject({ code: "invalid_request" }); expect(payload.error.requestId).toMatch(/^req_/); expect(profileCalls).toBe(0);
  });

  it("binds thread and feedback scope to bearer identity without revealing employee A data", async () => {
    const { url } = await api();
    await request(url, "/v1/me/consent", employeeToken, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accepted: true, source: "cli" }) });
    await request(url, "/v1/me/onboarding", employeeToken, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ roleId: "default_role", selfDescription: "manager", persona: "support" }) });
    const chat = await request(url, "/v1/me/threads/thread_a/messages", employeeToken, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "private" }) });
    const messageId = (await chat.json()).messageId;
    // Thread IDs are namespaced by employee in storage: B may create its own
    // `thread_a`, but cannot use A's message ID in feedback.
    const separateThread = await request(url, "/v1/me/threads/thread_a/messages", otherToken, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "probe" }) });
    expect(separateThread.status).toBe(200); expect(JSON.stringify(await separateThread.json())).not.toContain("private");
    const foreignFeedback = await request(url, "/v1/me/threads/thread_a/feedback", otherToken, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ targetMessageId: messageId, rating: "positive", source: "cli" }) });
    expect([403, 404]).toContain(foreignFeedback.status); expect(JSON.stringify(await foreignFeedback.json())).not.toContain("private");
  });

  it("returns redacted envelopes for malformed JSON, unsupported routes, and persistence errors", async () => {
    const { url } = await api();
    const malformed = await request(url, "/v1/me/consent", employeeToken, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(malformed.status).toBe(400); expect((await malformed.json()).error).toMatchObject({ code: "invalid_request" });
    for (const [method, path] of [["GET", "/v1/not-a-route"], ["PUT", "/v1/me/profile"]] as const) { const response = await request(url, path, employeeToken, { method }); expect(response.status).toBe(404); expect((await response.json()).error).toMatchObject({ code: "invalid_request", requestId: expect.stringMatching(/^req_/) }); }
    const statuses = { invite_not_found: 404, participant_not_found: 404, profile_not_found: 404, message_not_found: 404, session_not_found: 404, employee_already_linked: 409, chat_already_linked: 409, consent_required: 409, persistence_conflict: 409, persistence_unavailable: 503 } as const;
    for (const [code, status] of Object.entries(statuses)) expect(mapError(new PersistenceError(code as keyof typeof statuses)).status).toBe(status);
  });

  it("runs every Telegram service-plane operation through HTTP and retains /start API errors", async () => {
    const { runtime, url } = await api();
    const client = new ServiceMinutkaClient(new HttpServiceMinutkaTransport({ baseUrl: url, token: serviceToken }));
    const replies: string[] = [];
    const shell = createTelegramShell({ privacyExplanation: executableSpecPrivacyExplanation, client, sessionStore: runtime.telegramSessionStore, replyPort: { async sendMessage(_chatId, text) { replies.push(text); return { messageId: replies.length }; }, async sendChatAction() {}, async editReplyMarkup() {}, async answerCallbackQuery() {} }, speechToText: { async transcribe() { return ""; } }, voiceFileGateway: { async openVoiceFile() { throw new Error("not used in HTTP spec"); } } });
    await shell.handleStart("owner-chat", "invite_a", "owner-user"); await shell.handleStart("other-chat", "invite_a", "other-user");
    expect(replies.at(-1)).toContain("уже привязана к другому Telegram-аккаунту");
    const redeemed = await client.redeemTelegramInvite({ inviteCode: "invite_b", identity: { chatId: "service-chat", userId: "service-user" } });
    const employee = client.forEmployee(redeemed.employeeId);
    await employee.recordPrivacyExplanationShown(); await employee.acceptConsent({ accepted: true, source: "telegram", telegramIdentity: { chatId: "service-chat", userId: "service-user" } });
    await employee.completeOnboarding({ roleId: "default_role", selfDescription: "manager", persona: "support" });
    expect((await employee.getProfile()).employeeId).toBe("emp_b");
    const chat = await employee.chat({ threadId: redeemed.threadId, text: "hello", inputModality: "voice" }); await employee.submitFeedback({ threadId: redeemed.threadId, targetMessageId: chat.messageId, rating: "positive", source: "telegram" });
    expect(runtime.world.auditEvents.find((event) => event.type === "chat_received" && event.messageId === chat.messageId)?.metadata).toEqual({ inputModality: "voice" });
  });

  it("returns only active Minutka schedules when legacy rows still exist", async () => {
    const runtime = createInMemoryRuntime({ agentRunner: async () => "response", deps: createDefaultSpecDeps() });
    await runtime.scheduleStore.save("emp_a", {
      id: "emp_a:morning_planning-daily", daysOfWeek: 31, kind: "process", processId: "morning_planning", oneShot: false,
      timeOfDay: "08:30", timezone: "Europe/Moscow", enabled: true, nextFireAt: "2026-07-30T05:30:00.000Z",
    });
    await runtime.scheduleStore.save("emp_a", {
      id: "emp_a:day_focus-daily", daysOfWeek: 127, kind: "process", processId: "day_focus", oneShot: false,
      timeOfDay: "09:00", timezone: "Europe/Moscow", enabled: true, nextFireAt: "2026-07-30T06:00:00.000Z",
    });
    await runtime.scheduleStore.save("emp_a", {
      id: "legacy-reminder", daysOfWeek: 127, kind: "reminder", reminderText: "Секретный текст", oneShot: false,
      timeOfDay: "15:00", timezone: "Europe/Moscow", enabled: true, nextFireAt: "2026-07-30T12:00:00.000Z",
    });
    const scheduleManagement = new ScheduleManagementService(runtime.scheduleStore, {
      getProfile: async (employeeId) => runtime.world.profiles.find((profile) => profile.employeeId === employeeId),
    }, { now: () => runtime.world.now() });
    const application = {
      ...createSpecHttpApplication(runtime.service),
      listSchedules: (employeeId: string) => scheduleManagement.listSchedules(employeeId),
    };
    const server = await listenHttpServer({ application, port: 0, logger: () => undefined, auth: { serviceToken, employeeTokens: new Map() } });
    running.push(server);

    const response = await request(server.url, "/v1/service/employees/emp_a/schedules", serviceToken);
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload).toMatchObject({ schedules: [{ kind: "process", processId: "morning_planning" }] });
    expect(JSON.stringify(payload)).not.toContain("day_focus");
    expect(JSON.stringify(payload)).not.toContain("Секретный текст");
  });

  it("serializes AssistantService results and binds both chat planes to their trusted identity", async () => {
    const runtime = createInMemoryRuntime({ agentRunner: async () => "legacy", deps: createDefaultSpecDeps() });
    const calls: unknown[] = [];
    const assistant = { async chat(input: unknown) { calls.push(input); return { messageId: "msg_assistant", response: "assistant", selectedProcessIds: ["core", "inbox_capture"] as ["core", "inbox_capture"], outcome: { status: "completed" } as const, personalContextDocuments: ["context/private.md"], pendingActions: [], effect: "business_write_committed" as const }; } };
    const server = await listenHttpServer({ application: createSpecHttpApplication(runtime.service, assistant), port: 0, logger: () => undefined, auth: { serviceToken, employeeTokens: new Map([["emp_a", employeeToken]]) } });
    running.push(server);
    const client = new ServiceMinutkaClient(new HttpServiceMinutkaTransport({ baseUrl: server.url, token: serviceToken }));

    await expect(client.forEmployee("emp_a").chat({ threadId: "thread", text: "hello", inputModality: "voice" })).resolves.toEqual({
      messageId: "msg_assistant", response: "assistant", selectedProcessIds: ["core", "inbox_capture"], pendingActions: [], effect: "business_write_committed",
    });
    const employeeResponse = await request(server.url, "/v1/me/threads/me-thread/messages", employeeToken, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "private", inputModality: "text" }) });
    expect(employeeResponse.status).toBe(200);
    expect(calls).toEqual([
      expect.objectContaining({ userId: "emp_a", threadId: "thread", text: "hello", inputModality: "voice", signal: expect.any(AbortSignal) }),
      expect.objectContaining({ userId: "emp_a", threadId: "me-thread", text: "private", inputModality: "text", signal: expect.any(AbortSignal) }),
    ]);
    expect(chatResponseSchema.safeParse(await (await request(server.url, "/v1/service/employees/emp_a/threads/thread/messages", serviceToken, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hello" }) })).json()).success).toBe(true);
    expect(chatResponseSchema.safeParse({ messageId: "msg", response: "focus", selectedProcessIds: ["core", "day_focus"], pendingActions: [], effect: "none" }).success).toBe(true);
    expect(chatResponseSchema.safeParse({ messageId: "msg", response: "unsafe", selectedProcessIds: ["core", "unknown"], pendingActions: [], effect: "none" }).success).toBe(false);
    expect(chatResponseSchema.safeParse({ messageId: "msg", response: "legacy", selectedProcessIds: ["core", "workday_guardrails"], pendingActions: [], effect: "none" }).success).toBe(true);
  });

  it("rejects assistant capture for an unknown service employee before invoking the agent", async () => {
    const runtime = createInMemoryRuntime({ agentRunner: async () => "legacy", deps: createDefaultSpecDeps() });
    const assistant = { async chat() { throw new PersistenceError("participant_not_found"); } };
    const server = await listenHttpServer({ application: createSpecHttpApplication(runtime.service, assistant), port: 0, logger: () => undefined, auth: { serviceToken, employeeTokens: new Map() } });
    running.push(server);
    const response = await request(server.url, "/v1/service/employees/missing/threads/thread/messages", serviceToken, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "must not be captured" }) });
    expect(response.status).toBe(404);
    expect((await response.json()).error).toMatchObject({ code: "participant_not_found" });
  });

  it("returns a recovered proposal through real HTTP before the SDK deadline", async () => {
    const runtime = createInMemoryRuntime({ agentRunner: async () => "legacy", deps: createDefaultSpecDeps() });
    let agentCalls = 0;
    let proposalSaves = 0;
    let confirmationId: string | undefined;
    const budgets = { applicationMs: 10, recoveryReserveMs: 30, httpChatHandlerMs: 80, sdkTransportMs: 160, serverRequestMs: 240 };
    const assistant = {
      async chat(_input: { signal?: AbortSignal }) {
        agentCalls += 1;
        confirmationId = "http-deadline-confirmation";
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        proposalSaves += 1;
        await new Promise<void>((resolve) => setTimeout(resolve, budgets.applicationMs));
        return {
          messageId: "msg_deadline", response: "Предложение сохранено после остановки agent loop.", selectedProcessIds: ["core"] as Array<"core" | "inbox_capture" | "day_focus">,
          outcome: { status: "completed" } as const, effect: "pending_action_created" as const,
          pendingActions: [{
            confirmationId, actionKind: "create" as const, summary: "Создать задачу: HTTP deadline", expiresAt: "2026-07-29T09:15:00.000Z",
            preview: { kind: "create" as const, title: { value: "HTTP deadline", truncated: false }, project: { value: "ASSISTANT", truncated: false }, type: "operations" as const, dueDate: null },
          }],
        };
      },
    };
    const server = await listenHttpServer({ application: createSpecHttpApplication(runtime.service, assistant), port: 0, logger: () => undefined, auth: { serviceToken, employeeTokens: new Map() }, timeoutBudgets: budgets });
    running.push(server);
    const client = new ServiceMinutkaClient(new HttpServiceMinutkaTransport({ baseUrl: server.url, token: serviceToken, timeoutMs: budgets.sdkTransportMs }));

    await expect(client.forEmployee("emp_a").chat({ threadId: "thread", text: "create", responseChannel: "telegram" })).resolves.toMatchObject({
      messageId: "msg_deadline", effect: "pending_action_created", pendingActions: [{ confirmationId: "http-deadline-confirmation" }],
    });
    expect(agentCalls).toBe(1);
    expect(proposalSaves).toBe(1);
    expect(confirmationId).toBe("http-deadline-confirmation");
  });

  it("scopes conversational onboarding routes to the service employee", async () => {
    const { url } = await api();
    const client = new ServiceMinutkaClient(new HttpServiceMinutkaTransport({ baseUrl: url, token: serviceToken }));
    const employee = client.forEmployee("emp_a");
    await employee.acceptConsent({ accepted: true, source: "telegram" });
    expect(await employee.getOnboardingProgress()).toMatchObject({ status: "needs_choice", field: "roleId" });
    expect(await employee.submitOnboardingAnswer({ text: "default_role" })).toMatchObject({ status: "needs_answer", field: "preferredName" });
    expect(await employee.submitOnboardingAnswer({ text: "Максим" })).toMatchObject({ status: "needs_choice", field: "communicationStyle" });
    expect(await employee.resetOnboardingDraft()).toMatchObject({ status: "needs_choice", field: "roleId" });
    await employee.submitOnboardingAnswer({ text: "default_role" });
    await employee.submitOnboardingAnswer({ text: "Максим | На ты, коротко и по делу | Europe/Moscow" });
    expect(await employee.submitOnboardingAnswer({ text: "Исправить" })).toMatchObject({ status: "needs_correction" });
    await employee.confirmOnboarding();
    expect((await employee.getProfile()).employeeId).toBe("emp_a");
  });

  it("rate-limits employee mutations independently and defaults blank hosts to loopback", async () => {
    const { url } = await api(); const consent = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accepted: true, source: "cli" }) } as const;
    for (let index = 0; index < 60; index += 1) expect((await request(url, "/v1/me/consent", employeeToken, consent)).status).toBe(200);
    expect((await request(url, "/v1/me/consent", employeeToken, consent)).status).toBe(429); expect((await request(url, "/v1/me/consent", otherToken, consent)).status).toBe(200);
    const runtime = createInMemoryRuntime({ agentRunner: async () => "response", deps: createDefaultSpecDeps() });
    const server = await listenHttpServer({ application: createSpecHttpApplication(runtime.service), host: "", port: 0, logger: () => undefined, auth: { employeeTokens: new Map([["emp_a", employeeToken]]) } }); running.push(server); expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });

  it("uses trusted forwarded client IPs for non-loopback deployment and rejects unsafe proxy configuration", async () => {
    const runtime = createInMemoryRuntime({ agentRunner: async () => "response", deps: createDefaultSpecDeps() });
    await expect(listenHttpServer({ application: createSpecHttpApplication(runtime.service), host: "0.0.0.0", port: 0, allowNonLoopback: true, auth: { employeeTokens: new Map([["emp_a", employeeToken]]) } })).rejects.toThrow(/TRUST_PROXY/);
    const server = await listenHttpServer({ application: createSpecHttpApplication(runtime.service), host: "0.0.0.0", port: 0, allowNonLoopback: true, trustProxy: true, logger: () => undefined, auth: { employeeTokens: new Map([["emp_a", employeeToken]]) } }); running.push(server);
    for (let index = 0; index < 10; index += 1) expect((await request(server.url, "/v1/onboarding/invites/open", undefined, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.1" }, body: JSON.stringify({ inviteCode: "missing" }) })).status).toBe(404);
    expect((await request(server.url, "/v1/onboarding/invites/open", undefined, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.1" }, body: JSON.stringify({ inviteCode: "missing" }) })).status).toBe(429);
    expect((await request(server.url, "/v1/onboarding/invites/open", undefined, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.2" }, body: JSON.stringify({ inviteCode: "missing" }) })).status).toBe(404);
  });

  it("rejects credential collisions, logs redacted errors, and validates the strict timeout hierarchy", async () => {
    expect(chatHandlerTimeoutMs).toBeGreaterThanOrEqual(defaultHandlerTimeoutMs);
    expect(productionAssistantTimeoutBudgets).toMatchObject({ httpChatHandlerMs: chatHandlerTimeoutMs, serverRequestMs: serverRequestTimeoutMs });
    expect(() => assertAssistantTimeoutBudgets({ applicationMs: 10, recoveryReserveMs: 5, httpChatHandlerMs: 20, sdkTransportMs: 30, serverRequestMs: 40 })).not.toThrow();
    expect(() => assertAssistantTimeoutBudgets({ applicationMs: 10, recoveryReserveMs: 10, httpChatHandlerMs: 20, sdkTransportMs: 30, serverRequestMs: 40 })).not.toThrow();
    expect(() => assertAssistantTimeoutBudgets({ applicationMs: 10, recoveryReserveMs: 11, httpChatHandlerMs: 20, sdkTransportMs: 30, serverRequestMs: 40 })).toThrow(/satisfy/i);
    expect(() => assertAssistantTimeoutBudgets({ applicationMs: 20, recoveryReserveMs: 5, httpChatHandlerMs: 20, sdkTransportMs: 30, serverRequestMs: 40 })).toThrow(/satisfy/i);
    const duplicate = "x".repeat(64); expect(() => apiAuthConfigFromEnv({ MINUTKA_SERVICE_TOKEN: duplicate, MINUTKA_EMPLOYEE_TOKENS: `emp_a:${duplicate}` })).toThrow(/unique per principal/);
    const errors: unknown[] = []; const runtime = createInMemoryRuntime({ agentRunner: async () => "response", deps: createDefaultSpecDeps() });
    const server = await listenHttpServer({ application: createSpecHttpApplication(runtime.service), port: 0, health: async () => { throw new Error("secret-request-payload"); }, logger: () => undefined, errorLogger: (entry) => errors.push(entry), auth: { employeeTokens: new Map([["emp_a", employeeToken]]) } }); running.push(server);
    const response = await request(server.url, "/healthz"); expect(response.status).toBe(500); const payload = await response.json(); expect(payload.error).toMatchObject({ code: "internal_error", requestId: expect.stringMatching(/^req_/) }); expect(JSON.stringify(errors)).toContain(payload.error.requestId); expect(JSON.stringify(errors)).not.toContain("secret-request-payload");
  });
});
