import { afterEach, describe, expect, it } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { PersonalAssistantService } from "../../../src/application/personal-assistant-service.js";
import { createInMemoryArtifactContentStore } from "../../../src/application/in-memory-artifact-content-store.js";
import { createInMemoryArtifactStore } from "../../../src/application/in-memory-artifact-store.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryUsageStore } from "../../../src/application/in-memory-usage-store.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createInMemoryContextDocumentConfirmationStore } from "../../../src/application/in-memory-context-document-confirmation-store.js";
import { ContextDocumentService } from "../../../src/application/context-document-service.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { createDeterministicIdGenerator } from "../../../src/application/runtime-primitives.js";
import { AdminMinutkaClient, EmployeeMinutkaClient } from "../../../src/client/sdk/minutka-client.js";
import { HttpAdminMinutkaTransport, HttpEmployeeMinutkaTransport, MinutkaApiError } from "../../../src/client/sdk/http-transport.js";
import { createInProcessEmployeeTransport } from "../../../src/server/http/in-process-transport.js";
import { runMinutkaCli } from "../../../src/client/cli/minutka-cli.js";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { listenHttpServer, type RunningHttpServer } from "../../../src/server/http/http-server.js";
import { GroupUsageReportingService, type GroupUsageStore } from "../../../src/application/group-usage-reporting.js";
import type { UsageStore } from "../../../src/application/usage-store.js";
import { createSpecParticipantStore } from "../support/participant-store.js";

const employeeToken = "a".repeat(64); const serviceToken = "c".repeat(64); const adminToken = "d".repeat(64); const running: RunningHttpServer[] = []; const silent = () => undefined;
const testTenantBinding = { companyId: "default_company", groupId: "default_group" } as const;
afterEach(async () => { await Promise.all(running.splice(0).map((server) => server.close())); });

describe("SPEC-CLI-HTTP-001: CLI runs through TCP HTTP transport", () => {
  it("uses the same state as the listener and derives employee identity from its token", async () => {
    const runtime = createInMemoryRuntime({ agentRunner: async () => "legacy" });
    const application = createApplication(runtime, "first response");
    await application.issueInvite({ employeeId: "emp_cli", inviteCode: "invite_cli", ...testTenantBinding });
    const server = await listenHttpServer({ application, port: 0, logger: silent, auth: { adminToken, employeeTokens: new Map([["emp_cli", employeeToken]]) } }); running.push(server);
    const client = new EmployeeMinutkaClient(new HttpEmployeeMinutkaTransport({ baseUrl: server.url, token: employeeToken }));
    expect((await runMinutkaCli(client, ["employee", "open-invite", "--invite", "invite_cli"])).exitCode).toBe(0);
    expect((await runMinutkaCli(client, ["employee", "accept-consent", "--yes"])).exitCode).toBe(0);
    // A role of another company is refused as a contract error with a visible
    // reason, not as an unknown runtime failure.
    runtime.world.tenantDirectories.roles.push({ id: "role_other_company", companyId: "other_company", name: "Бухгалтер" });
    const foreignRole = await runMinutkaCli(client, ["employee", "complete-onboarding", "--role-id", "role_other_company", "--persona", "support"]);
    expect(foreignRole.exitCode).toBe(1); expect(foreignRole.stdout).toEqual([]);
    expect(foreignRole.stderr.at(-1)).toBe("roleId must belong to the participant company");
    expect(foreignRole.stderr.join("\n")).not.toContain("Internal server error");
    const foreignRoleResponse = await fetch(`${server.url}/v1/me/onboarding`, { method: "POST", headers: { authorization: `Bearer ${employeeToken}`, "content-type": "application/json" }, body: JSON.stringify({ roleId: "role_other_company", persona: "support" }) });
    expect(foreignRoleResponse.status).toBe(400);
    expect((await foreignRoleResponse.json()).error).toMatchObject({ code: "invalid_request", message: "roleId must belong to the participant company" });
    const onboarding = await runMinutkaCli(client, ["employee", "complete-onboarding", "--role-id", "default_role", "--self-description", "manager", "--typical-task", "weekly reporting", "--ai-level", "intermediate", "--program-goal", "reduce routine", "--persona", "support"]);
    expect(onboarding.exitCode).toBe(0);
    expect(await client.getProfile()).toMatchObject({ typicalTasks: ["weekly reporting"], aiLevel: "intermediate", programGoal: "reduce routine" });
    // Without --name the assistant falls back to the employee ID; with the flag
    // the value reaches the use-case instead of being dropped by the parser.
    expect((await client.getProfile()).preferredName).toBe("emp_cli");
    const named = await runMinutkaCli(client, ["employee", "complete-onboarding", "--name", "Алексей", "--role-id", "default_role", "--self-description", "manager", "--persona", "support"]);
    expect(named.exitCode).toBe(0);
    const namedProfile = await runMinutkaCli(client, ["employee", "profile"]);
    expect(JSON.parse(namedProfile.stdout.at(-1) ?? "{}").preferredName).toBe("Алексей");
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

    const first = await runMinutkaCli(client, ["admin", "invite", "--employee", "emp_first", "--company", "default_company", "--group", "default_group", "--bot", "pilot_test_bot"]);
    const second = await runMinutkaCli(client, ["admin", "invite", "--employee", "emp_second", "--company", "default_company", "--group", "default_group"], { TELEGRAM_BOT_USERNAME: "@pilot_test_bot" });
    expect(first.exitCode).toBe(0); expect(second.exitCode).toBe(0);
    const firstCode = new URL(first.stdout[1]).searchParams.get("start");
    const secondCode = new URL(second.stdout[1]).searchParams.get("start");
    expect(firstCode).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(secondCode).toMatch(/^[A-Za-z0-9_-]{43}$/); expect(secondCode).not.toBe(firstCode);
    expect(first.stdout[2]).toContain("cannot be recovered");
    expect(JSON.stringify(runtime.world)).not.toContain(firstCode);

    let listCalls = 0;
    const originalListParticipants = client.listParticipants.bind(client);
    client.listParticipants = async (...args) => { listCalls += 1; return originalListParticipants(...args); };
    const repeated = await runMinutkaCli(client, ["admin", "invite", "--employee", "emp_first", "--company", "default_company", "--group", "default_group", "--bot", "pilot_test_bot"]);
    expect(repeated.exitCode).toBe(1); expect(repeated.stderr.at(-1)).toContain("employee already has an active invite"); expect(repeated.stdout).toEqual([]);
    expect(listCalls).toBe(0);
    expect((await client.listParticipants(testTenantBinding)).participants.find(({ employeeId }) => employeeId === "emp_first")).toBeDefined();
  });

  it("reports one employee's monthly usage with source and cache breakdown for the operator", async () => {
    const runtime = createInMemoryRuntime({ agentRunner: async () => "legacy" });
    const usageStore = createInMemoryUsageStore();
    await usageStore.record({
      id: "usage_chat", userId: "emp_usage", requestId: "req_chat", source: "chat", month: "2026-07",
      inputTokens: 1_200, cachedInputTokens: 800, outputTokens: 300, totalTokens: 1_500,
      estimatedCostUsdMicros: 12_345, occurredAt: "2026-07-10T00:00:00.000Z",
    });
    await usageStore.record({
      id: "usage_guard", userId: "emp_usage", requestId: "req_guard", source: "guard", month: "2026-07",
      inputTokens: 100, outputTokens: 20, totalTokens: 120,
      estimatedCostUsdMicros: 655, occurredAt: "2026-07-10T00:00:01.000Z",
    });
    const application = createApplication(runtime, "unused", usageStore);
    const server = await listenHttpServer({ application, port: 0, logger: silent, auth: { adminToken, serviceToken, employeeTokens: new Map([["emp_usage", employeeToken]]) } }); running.push(server);

    for (const token of [employeeToken, serviceToken]) {
      const forbidden = await fetch(`${server.url}/v1/admin/employees/emp_usage/usage?month=2026-07`, { headers: { authorization: `Bearer ${token}` } });
      expect(forbidden.status).toBe(403);
    }
    const result = await runMinutkaCli(
      new AdminMinutkaClient(new HttpAdminMinutkaTransport({ baseUrl: server.url, token: adminToken })),
      ["admin", "usage", "--employee", "emp_usage", "--month", "2026-07"],
    );
    expect(result).toMatchObject({ exitCode: 0, stderr: [] });
    expect(result.stdout).toEqual([
      "Employee: emp_usage",
      "Month (UTC): 2026-07",
      "Tokens: input 1,300, cached input 800, output 320, total 1,620",
      "Estimated cost: $0.013000 USD",
      "Records: 2; cache breakdown unknown for 1 record(s)",
      "  chat: 1,500 tokens (800 cached input), $0.012345 USD, 1 record(s), 0 cache-unknown",
      "  guard: 120 tokens (0 cached input), $0.000655 USD, 1 record(s), 1 cache-unknown",
    ]);

    const invalid = await runMinutkaCli(
      new AdminMinutkaClient(new HttpAdminMinutkaTransport({ baseUrl: server.url, token: adminToken })),
      ["admin", "usage", "--employee", "emp_usage", "--month", "2026-13"],
    );
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr.at(-1)).toContain("month must use YYYY-MM");
  });

  it("reports tenant-scoped monthly group usage and excludes cache-unknown rows from cache share", async () => {
    const runtime = createInMemoryRuntime({ agentRunner: async () => "legacy" });
    runtime.world.tenantDirectories.groups.push({ id: "other_group", companyId: "other_company" });
    const usageStore = createInMemoryUsageStore(() => runtime.world.participants);
    const application = createApplication(runtime, "unused", usageStore);
    await application.issueInvite({ employeeId: "emp_group_a", inviteCode: "invite_group_a", ...testTenantBinding });
    await application.issueInvite({ employeeId: "emp_group_b", inviteCode: "invite_group_b", ...testTenantBinding });
    await application.issueInvite({ employeeId: "emp_foreign_usage", inviteCode: "invite_foreign_usage", companyId: "other_company", groupId: "other_group" });
    await usageStore.record({ id: "group_chat_a", userId: "emp_group_a", requestId: "group_req_a", source: "chat", month: "2026-07", inputTokens: 1_200, cachedInputTokens: 800, outputTokens: 300, totalTokens: 1_500, estimatedCostUsdMicros: 12_345, occurredAt: "2026-07-10T00:00:00.000Z" });
    await usageStore.record({ id: "group_guard_a", userId: "emp_group_a", requestId: "group_guard_req_a", source: "guard", month: "2026-07", inputTokens: 100, outputTokens: 20, totalTokens: 120, estimatedCostUsdMicros: 655, occurredAt: "2026-07-10T00:00:01.000Z" });
    await usageStore.record({ id: "group_chat_b", userId: "emp_group_b", requestId: "group_req_b", source: "chat", month: "2026-07", inputTokens: 800, cachedInputTokens: 0, outputTokens: 100, totalTokens: 900, estimatedCostUsdMicros: 5_000, occurredAt: "2026-07-11T00:00:00.000Z" });
    await usageStore.record({ id: "group_foreign", userId: "emp_foreign_usage", requestId: "group_req_foreign", source: "chat", month: "2026-07", inputTokens: 99_999, cachedInputTokens: 99_999, outputTokens: 999, totalTokens: 100_998, estimatedCostUsdMicros: 999_999, occurredAt: "2026-07-12T00:00:00.000Z" });
    const server = await listenHttpServer({ application, port: 0, logger: silent, auth: { adminToken, employeeTokens: new Map() } }); running.push(server);
    const client = new AdminMinutkaClient(new HttpAdminMinutkaTransport({ baseUrl: server.url, token: adminToken }));

    const result = await runMinutkaCli(client, ["admin", "usage", "--company", "default_company", "--group", "default_group", "--month", "2026-07"]);
    expect(result).toMatchObject({ exitCode: 0, stderr: [] });
    expect(result.stdout).toEqual([
      "Scope: default_company/default_group",
      "Month (UTC): 2026-07",
      "Participants: 2; above $0.01 soft limit: 1",
      "Tokens: input 2,100, cached input 800, output 420, total 2,520",
      "Cache share (reported rows only): 40.00%",
      "Estimated cost: $0.018000 USD",
      "  chat: 2,400 tokens (800 cached input), cache share 40.00%, $0.017345 USD",
      "  guard: 120 tokens (0 cached input), cache share n/a, $0.000655 USD",
      "Above soft limit: emp_group_a ($0.013000)",
    ]);
    expect(result.stdout.join("\n")).not.toContain("emp_foreign_usage");
    expect(result.stdout.join("\n")).not.toContain("99,999");

    const missingScope = await runMinutkaCli(client, ["admin", "usage", "--company", "default_company", "--month", "2026-07"]);
    expect(missingScope).toMatchObject({ exitCode: 1, stdout: [] });
    expect(missingScope.stderr.at(-1)).toBe("--company and --group are required together");
    expect((await fetch(`${server.url}/v1/admin/usage?companyId=default_company&month=2026-07`, { headers: { authorization: `Bearer ${adminToken}` } })).status).toBe(400);
  });

  it("lists and restores context document versions only for operator credentials", async () => {
    let now = "2026-08-03T10:00:00.000Z";
    const runtime = createInMemoryRuntime({ agentRunner: async () => "legacy", world: createInMemoryWorld(() => now) });
    const clock = { now: () => now };
    const documentStore = createInMemoryDocumentStore(clock);
    const contextDocuments = new ContextDocumentService(documentStore, createInMemoryContextDocumentConfirmationStore(), clock, {
      auditEventStore: createInMemoryAuditEventStore(runtime.world), idGenerator: createDeterministicIdGenerator(),
    });
    const first = await documentStore.put("emp_docs", "context/00_inbox/recover.md", "first body");
    now = "2026-08-03T11:00:00.000Z";
    const second = await documentStore.put("emp_docs", "context/00_inbox/recover.md", "second body");
    await documentStore.deleteIfVersion("emp_docs", "context/00_inbox/recover.md", second.version);
    await documentStore.put("other", "context/00_inbox/recover.md", "private body");
    const application = createApplication(runtime, "unused", undefined, contextDocuments, documentStore);
    const server = await listenHttpServer({ application, port: 0, logger: silent, auth: { adminToken, serviceToken, employeeTokens: new Map([["emp_docs", employeeToken]]) } }); running.push(server);
    const versionsUrl = `${server.url}/v1/admin/employees/emp_docs/context-documents/versions?path=${encodeURIComponent("/proc/context/00_inbox/recover.md")}`;
    const restoreUrl = `${server.url}/v1/admin/employees/emp_docs/context-documents/restore`;

    for (const token of [employeeToken, serviceToken]) {
      expect((await fetch(versionsUrl, { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
      expect((await fetch(restoreUrl, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ path: "/proc/context/00_inbox/recover.md", version: first.version }) })).status).toBe(403);
    }

    const client = new AdminMinutkaClient(new HttpAdminMinutkaTransport({ baseUrl: server.url, token: adminToken }));
    const listed = await runMinutkaCli(client, ["admin", "context-document-versions", "--employee", "emp_docs", "--path", "/proc/context/00_inbox/recover.md", "--limit", "1"]);
    expect(listed).toMatchObject({ exitCode: 0, stderr: [] });
    expect(listed.stdout).toEqual([
      "Document: /proc/context/00_inbox/recover.md",
      "UPDATED_AT\tSIZE_BYTES\tVERSION",
      `2026-08-03T11:00:00.000Z\t11\t${second.version}`,
    ]);
    const restored = await runMinutkaCli(client, ["admin", "restore-context-document", "--employee", "emp_docs", "--path", "/proc/context/00_inbox/recover.md", "--version", first.version]);
    expect(restored).toMatchObject({ exitCode: 0, stderr: [] });
    expect(restored.stdout).toEqual([expect.stringContaining("Restored /proc/context/00_inbox/recover.md as version")]);
    await expect(documentStore.get("emp_docs", "context/00_inbox/recover.md")).resolves.toMatchObject({ content: "first body" });
    await expect(documentStore.get("other", "context/00_inbox/recover.md")).resolves.toMatchObject({ content: "private body" });

    for (const invalidPath of ["context/00_inbox/recover.md", "emp_docs/context/00_inbox/recover.md"]) {
      const invalid = await fetch(`${server.url}/v1/admin/employees/emp_docs/context-documents/versions?path=${encodeURIComponent(invalidPath)}`, { headers: { authorization: `Bearer ${adminToken}` } });
      expect(invalid.status).toBe(400);
    }
    for (const limit of ["0", "101", "not-a-number"]) {
      const invalid = await fetch(`${versionsUrl}&limit=${limit}`, { headers: { authorization: `Bearer ${adminToken}` } });
      expect(invalid.status).toBe(400);
    }
    const foreignVersions = await client.listContextDocumentVersions({ employeeId: "missing-owner", path: "/proc/context/00_inbox/recover.md" });
    expect(foreignVersions).toEqual({ path: "/proc/context/00_inbox/recover.md", versions: [] });
    const foreignRestore = await client.restoreContextDocumentVersion({ employeeId: "other", path: "/proc/context/00_inbox/recover.md", version: first.version });
    expect(foreignRestore).toEqual({ outcome: "not_found", path: "/proc/context/00_inbox/recover.md" });
    await expect(documentStore.get("other", "context/00_inbox/recover.md")).resolves.toMatchObject({ content: "private body" });
    expect(runtime.world.auditEvents).toContainEqual(expect.objectContaining({
      type: "context_document_mutated", employeeId: "emp_docs", metadata: expect.objectContaining({ operation: "restore", path: "/proc/context/00_inbox/recover.md", outcome: "restored" }),
    }));
  });

  it("lists only the requested company/group and exposes only participation fields", async () => {
    let now = "2026-01-05T12:00:00.000Z";
    let instant = 0;
    const world = createInMemoryWorld(() => instant++ === 0 ? now : new Date(Date.parse(now) + instant * 1_000).toISOString());
    world.tenantDirectories.groups.push({ id: "group_b", companyId: "company_b" });
    const runtime = createInMemoryRuntime({ agentRunner: async () => "legacy", world });
    const application = createApplication(runtime, "unused");
    for (let index = 0; index < 25; index += 1) await application.issueInvite({ employeeId: `emp_${String(index).padStart(3, "0")}`, inviteCode: `invite_${index}`, ...testTenantBinding });
    await application.issueInvite({ employeeId: "emp_foreign", inviteCode: "invite_foreign", companyId: "company_b", groupId: "group_b" });
    await application.openInvite({ inviteCode: "invite_0" });
    await application.acceptConsent({ employeeId: "emp_000", accepted: true, source: "cli" });
    await application.completeOnboarding({ employeeId: "emp_000", roleId: "default_role", preferredName: "Private Name", assistantName: "Spark", addressForm: "informal", timezone: "Europe/Moscow", persona: "support" });
    const participant = world.participants.find(({ employeeId }) => employeeId === "emp_000")!;
    participant.lastTouchOn = "2026-01-03";
    const server = await listenHttpServer({ application, port: 0, logger: silent, auth: { adminToken, serviceToken, employeeTokens: new Map([["emp_000", employeeToken]]) } }); running.push(server);

    for (const token of [employeeToken, serviceToken]) {
      const forbidden = await fetch(`${server.url}/v1/admin/participants?companyId=default_company&groupId=default_group`, { headers: { authorization: `Bearer ${token}` } });
      expect(forbidden.status).toBe(403);
    }
    const client = new AdminMinutkaClient(new HttpAdminMinutkaTransport({ baseUrl: server.url, token: adminToken }));
    const first = await runMinutkaCli(client, ["admin", "list-participants", "--company", "default_company", "--group", "default_group"]);
    expect(first).toMatchObject({ exitCode: 0, stderr: [] });
    const firstPage = JSON.parse(first.stdout[0] ?? "{}");
    expect(firstPage.participants).toHaveLength(20);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    expect(first.stdout[1]).toBe(`Next page: npm run cli -- admin list-participants --company default_company --group default_group --after ${firstPage.nextCursor}`);

    const second = await runMinutkaCli(client, ["admin", "list-participants", "--company", "default_company", "--group", "default_group", "--after", firstPage.nextCursor]);
    expect(second).toMatchObject({ exitCode: 0, stderr: [] });
    const secondPage = JSON.parse(second.stdout[0] ?? "{}");
    const combined = [...firstPage.participants, ...secondPage.participants];
    expect(combined).toHaveLength(25);
    expect(combined.map((entry: { employeeId: string }) => entry.employeeId)).not.toContain("emp_foreign");
    expect(combined.find((entry: { employeeId: string }) => entry.employeeId === "emp_000")).toEqual({
      employeeId: "emp_000", status: "profile_completed", lastTouchOn: "2026-01-03", engagement: "lagging",
    });
    expect(Object.keys(combined[0]).sort()).toEqual(expect.arrayContaining(["employeeId", "engagement", "status"]));
    expect(Object.keys(combined[0])).not.toEqual(expect.arrayContaining(["createdAt", "updatedAt"]));
    expect(first.stdout.join("\n") + second.stdout.join("\n")).not.toContain("Private Name");
    expect(first.stdout.join("\n") + second.stdout.join("\n")).not.toContain("Europe/Moscow");
    expect(first.stdout.join("\n") + second.stdout.join("\n")).not.toContain("chatId");

    now = "2026-01-06T12:00:00.000Z";
    const dropped = await client.listParticipants({ ...testTenantBinding });
    expect(dropped.participants).toContainEqual(expect.objectContaining({ employeeId: "emp_000", engagement: "dropped_off" }));
    await expect(client.listParticipants({ ...testTenantBinding, after: "not-a-participant-cursor" })).rejects.toMatchObject({ code: "invalid_request", message: "Invalid participant cursor." } satisfies Partial<MinutkaApiError>);
    expect((await fetch(`${server.url}/v1/admin/participants`, { headers: { authorization: `Bearer ${adminToken}` } })).status).toBe(400);
  });
});

function createApplication(
  runtime: ReturnType<typeof createInMemoryRuntime>,
  response: string,
  usageStore?: Pick<UsageStore, "getMonthly"> & Partial<GroupUsageStore>,
  contextDocuments?: ContextDocumentService,
  providedDocumentStore?: ReturnType<typeof createInMemoryDocumentStore>,
): PersonalAssistantService {
  const clock = { now: runtime.world.now };
  const documentStore = providedDocumentStore ?? createInMemoryDocumentStore(clock);
  const ingestionService = createIngestionService({ documentStore, blobStore: createInMemoryBlobStore(clock) });
  const assistant = new AssistantService(async () => response, {
    documentStore,
    conversationStore: createInMemoryConversationStore(runtime.world),
    ingestionService,
    participantStore: createSpecParticipantStore(),
    requestIntegrityGuard: async () => ({ status: "allowed" }),
    clock,
    idGenerator: createDeterministicIdGenerator(),
  });
  const artifactStore = createInMemoryArtifactStore({
    contentStore: createInMemoryArtifactContentStore(clock),
    clock,
    limits: { maximumBytes: 1024, timeoutMs: 1_000 },
  });
  const groupUsage = usageStore?.getGroupMonthly
    ? new GroupUsageReportingService(usageStore as GroupUsageStore, { monthlySoftLimitUsdMicros: 10_000 })
    : undefined;
  return new PersonalAssistantService(runtime.service, assistant, artifactStore, undefined, undefined, undefined, undefined, usageStore, contextDocuments, undefined, groupUsage);
}
