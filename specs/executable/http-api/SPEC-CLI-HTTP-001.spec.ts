import { afterEach, describe, expect, it } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { PersonalAssistantService } from "../../../src/application/personal-assistant-service.js";
import { createInMemoryArtifactContentStore } from "../../../src/application/in-memory-artifact-content-store.js";
import { createInMemoryArtifactStore } from "../../../src/application/in-memory-artifact-store.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { createDeterministicIdGenerator } from "../../../src/application/runtime-primitives.js";
import { AdminMinutkaClient, EmployeeMinutkaClient } from "../../../src/client/sdk/minutka-client.js";
import { HttpAdminMinutkaTransport, HttpEmployeeMinutkaTransport } from "../../../src/client/sdk/http-transport.js";
import { createInProcessEmployeeTransport } from "../../../src/server/http/in-process-transport.js";
import { runMinutkaCli } from "../../../src/client/cli/minutka-cli.js";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import { listenHttpServer, type RunningHttpServer } from "../../../src/server/http/http-server.js";

const employeeToken = "a".repeat(64); const serviceToken = "c".repeat(64); const adminToken = "d".repeat(64); const running: RunningHttpServer[] = []; const silent = () => undefined;
afterEach(async () => { await Promise.all(running.splice(0).map((server) => server.close())); });

describe("SPEC-CLI-HTTP-001: CLI runs through TCP HTTP transport", () => {
  it("uses the same state as the listener and derives employee identity from its token", async () => {
    const runtime = createInMemoryRuntime({ agentRunner: async () => "legacy" });
    const application = createApplication(runtime, "first response");
    await application.issueInvite({ employeeId: "emp_cli", inviteCode: "invite_cli" });
    const server = await listenHttpServer({ application, port: 0, logger: silent, auth: { adminToken, employeeTokens: new Map([["emp_cli", employeeToken]]) } }); running.push(server);
    const client = new EmployeeMinutkaClient(new HttpEmployeeMinutkaTransport({ baseUrl: server.url, token: employeeToken }));
    expect((await runMinutkaCli(client, ["employee", "open-invite", "--invite", "invite_cli"])).exitCode).toBe(0);
    expect((await runMinutkaCli(client, ["employee", "accept-consent", "--yes"])).exitCode).toBe(0);
    const onboarding = await runMinutkaCli(client, ["employee", "complete-onboarding", "--role", "manager", "--task", "planning", "--persona", "support", "--ai-level", "beginner"]);
    expect(onboarding.exitCode).toBe(0);
    const chat = await runMinutkaCli(client, ["employee", "chat", "--thread", "thread_cli", "--text", "hello"]);
    expect(chat.exitCode).toBe(0); const messageId = JSON.parse(chat.stdout.at(-1) ?? "{}").messageId;
    const feedback = await runMinutkaCli(client, ["employee", "feedback", "--thread", "thread_cli", "--target-message", messageId, "--rating", "positive"]);
    expect(feedback.exitCode).toBe(0);
    expect(JSON.parse(feedback.stdout.at(-1) ?? "{}").selectedProcessIds).toEqual([]);
    expect((await application.getProfile({ employeeId: "emp_cli" })).role).toBe("manager");
    const inProcessClient = new EmployeeMinutkaClient(createInProcessEmployeeTransport(runtime.service, { kind: "employee", employeeId: "emp_cli" }));
    expect(await inProcessClient.getProfile()).toEqual(await client.getProfile());
    expect(await inProcessClient.listInsights({})).toEqual(await client.listInsights({}));
  });

  it("generates one-time deep links and keeps repeated issuance semantics predictable", async () => {
    const runtime = createInMemoryRuntime({ agentRunner: async () => "legacy" });
    const application = createApplication(runtime, "unused");
    const server = await listenHttpServer({ application, port: 0, logger: silent, auth: { adminToken, employeeTokens: new Map() } }); running.push(server);
    const client = new AdminMinutkaClient(new HttpAdminMinutkaTransport({ baseUrl: server.url, token: adminToken }));

    const first = await runMinutkaCli(client, ["admin", "invite", "--employee", "emp_first", "--bot", "pilot_test_bot"]);
    const second = await runMinutkaCli(client, ["admin", "invite", "--employee", "emp_second"], { TELEGRAM_BOT_USERNAME: "@pilot_test_bot" });
    expect(first.exitCode).toBe(0); expect(second.exitCode).toBe(0);
    const firstCode = new URL(first.stdout[1]).searchParams.get("start");
    const secondCode = new URL(second.stdout[1]).searchParams.get("start");
    expect(firstCode).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(secondCode).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(secondCode).not.toBe(firstCode);
    expect(first.stdout[2]).toContain("cannot be recovered");
    expect(JSON.stringify(runtime.world)).not.toContain(firstCode);

    const repeated = await runMinutkaCli(client, ["admin", "invite", "--employee", "emp_first", "--bot", "pilot_test_bot"]);
    expect(repeated.exitCode).toBe(1); expect(repeated.stderr.at(-1)).toContain("already has a participant"); expect(repeated.stdout).toEqual([]);
  });

  it("lists only bounded non-personal participant fields for operator credentials", async () => {
    const runtime = createInMemoryRuntime({ agentRunner: async () => "legacy" });
    const application = createApplication(runtime, "unused");
    await application.issueInvite({ employeeId: "emp_private", inviteCode: "invite_private" });
    await application.openInvite({ inviteCode: "invite_private" });
    await application.acceptConsent({ employeeId: "emp_private", accepted: true, source: "cli" });
    await application.completeOnboarding({ employeeId: "emp_private", preferredName: "Private Name", assistantName: "Spark", addressForm: "informal", timezone: "Europe/Moscow", persona: "support" });
    runtime.world.participants[0].createdAt = "2020-01-01T00:00:00.000Z";
    for (let index = 0; index < 105; index += 1) await application.issueInvite({ employeeId: `emp_${String(index).padStart(3, "0")}`, inviteCode: `invite_${index}` });
    const server = await listenHttpServer({ application, port: 0, logger: silent, auth: { adminToken, serviceToken, employeeTokens: new Map([["emp_private", employeeToken]]) } }); running.push(server);

    for (const token of [employeeToken, serviceToken]) {
      const forbidden = await fetch(`${server.url}/v1/admin/participants`, { headers: { authorization: `Bearer ${token}` } });
      expect(forbidden.status).toBe(403);
    }
    const listed = await runMinutkaCli(new AdminMinutkaClient(new HttpAdminMinutkaTransport({ baseUrl: server.url, token: adminToken })), ["admin", "list-participants"]);
    expect(listed.exitCode).toBe(0);
    const participants = JSON.parse(listed.stdout.at(-1) ?? "[]");
    expect(participants).toHaveLength(100);
    expect(participants).toContainEqual({ employeeId: "emp_000", status: "invite_issued", createdAt: expect.any(String), updatedAt: expect.any(String) });
    expect(participants).toContainEqual({ employeeId: "emp_private", status: "profile_completed", createdAt: expect.any(String), updatedAt: expect.any(String) });
    expect(Object.keys(participants[0]).sort()).toEqual(["createdAt", "employeeId", "status", "updatedAt"]);
    expect(JSON.stringify(runtime.world.profiles)).toContain("Private Name");
    expect(listed.stdout.join("\n")).not.toContain("Private Name");
    expect(listed.stdout.join("\n")).not.toContain("Europe/Moscow");
    expect(listed.stdout.join("\n")).not.toContain("chatId");
  });
});

function createApplication(runtime: ReturnType<typeof createInMemoryRuntime>, response: string): PersonalAssistantService {
  const clock = { now: runtime.world.now };
  const documentStore = createInMemoryDocumentStore(clock);
  const ingestionService = createIngestionService({ documentStore, blobStore: createInMemoryBlobStore(clock) });
  const assistant = new AssistantService(async () => response, {
    documentStore,
    conversationStore: createInMemoryConversationStore(runtime.world),
    ingestionService,
    requestIntegrityGuard: async () => ({ status: "allowed" }),
    clock,
    idGenerator: createDeterministicIdGenerator(),
  });
  const artifactStore = createInMemoryArtifactStore({
    contentStore: createInMemoryArtifactContentStore(clock),
    clock,
    limits: { maximumBytes: 1024, timeoutMs: 1_000 },
  });
  return new PersonalAssistantService(runtime.service, assistant, artifactStore);
}
