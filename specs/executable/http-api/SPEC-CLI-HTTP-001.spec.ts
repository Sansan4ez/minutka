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

const employeeToken = "a".repeat(64); const adminToken = "d".repeat(64); const running: RunningHttpServer[] = []; const silent = () => undefined;
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
    expect(JSON.parse(feedback.stdout.at(-1) ?? "{}").selectedProcessIds).toEqual(["core", "feedback"]);
    expect((await application.getProfile({ employeeId: "emp_cli" })).role).toBe("manager");
    const inProcessClient = new EmployeeMinutkaClient(createInProcessEmployeeTransport(runtime.service, { kind: "employee", employeeId: "emp_cli" }));
    expect(await inProcessClient.getProfile()).toEqual(await client.getProfile());
    expect(await inProcessClient.listInsights({})).toEqual(await client.listInsights({}));
  });

  it("permits invite issuance only for operator credentials", async () => {
    const runtime = createInMemoryRuntime({ agentRunner: async () => "legacy" });
    const application = createApplication(runtime, "unused");
    const server = await listenHttpServer({ application, port: 0, logger: silent, auth: { adminToken, employeeTokens: new Map([["emp_cli", employeeToken]]) } }); running.push(server);
    // An employee client has no issueInvite method at compile time; the server still
    // rejects a forged admin-plane request made with its bearer credential.
    const employeeResponse = await fetch(`${server.url}/v1/admin/invites`, { method: "POST", headers: { authorization: `Bearer ${employeeToken}`, "content-type": "application/json" }, body: JSON.stringify({ employeeId: "emp_new", inviteCode: "invite_new" }) });
    expect(employeeResponse.status).toBe(403);
    const adminResult = await runMinutkaCli(new AdminMinutkaClient(new HttpAdminMinutkaTransport({ baseUrl: server.url, token: adminToken })), ["admin", "issue-invite", "--employee", "emp_new", "--invite", "invite_new"]);
    expect(adminResult.exitCode).toBe(0);
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
