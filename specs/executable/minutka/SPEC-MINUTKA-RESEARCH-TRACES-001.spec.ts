import { describe, expect, it } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryProfileStore } from "../../../src/application/in-memory-profile-store.js";
import { createInMemoryResearchTraceState, createInMemoryResearchTraceStore } from "../../../src/application/in-memory-research-trace-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { createDeterministicIdGenerator } from "../../../src/application/runtime-primitives.js";
import { exportResearchTracesJson } from "../../../src/application/research-trace-store.js";

const now = "2026-08-18T20:00:00.000Z";
const versions = {
  promptVersion: "prompt/v1",
  processVersion: "process/v1",
  taxonomyVersion: "taxonomy/v1",
  model: "openai/test-model",
};

async function readyParticipant(world: ReturnType<typeof createInMemoryWorld>, employeeId: string, companyId: string, groupId: string) {
  world.tenantDirectories.groups.push({ id: groupId, companyId });
  world.tenantDirectories.roles.push({ id: `role_${companyId}`, companyId, name: "Role" });
  const profiles = createInMemoryProfileStore(world);
  await profiles.issueInvite({ employeeId, inviteCode: `invite_${employeeId}`, companyId, groupId, issuedAt: now });
  await profiles.openInvite({ inviteCode: `invite_${employeeId}`, openedAt: now, explanationShownAt: now });
  await profiles.acceptConsent({ employeeId, privacyVersion: "privacy-v6", acceptedAt: now, explanationShownAt: now, source: "test" });
  await profiles.completeProfile({
    completedAt: now,
    profile: {
      employeeId, companyId, groupId, roleId: `role_${companyId}`,
      preferredName: "Employee", assistantName: "Minutka", addressForm: "informal", persona: "support",
      responseLength: "short", timezone: "Etc/UTC", createdAt: now, updatedAt: now,
    },
  });
  return profiles;
}

function service(input: {
  world: ReturnType<typeof createInMemoryWorld>;
  profiles: ReturnType<typeof createInMemoryProfileStore>;
  traces: ReturnType<typeof createInMemoryResearchTraceStore>;
  runner: ConstructorParameters<typeof AssistantService>[0];
  warnings?: unknown[];
}) {
  const clock = { now: () => now };
  const documents = createInMemoryDocumentStore(clock);
  return new AssistantService(input.runner, {
    documentStore: documents,
    conversationStore: createInMemoryConversationStore(input.world),
    ingestionService: createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock) }),
    requestIntegrityGuard: async () => ({ status: "allowed" }),
    participantStore: input.profiles,
    researchTraceStore: input.traces,
    researchTraceVersions: versions,
    auditEventStore: createInMemoryAuditEventStore(input.world),
    operationalLogger: (warning) => input.warnings?.push(warning),
    clock,
    idGenerator: createDeterministicIdGenerator(),
  });
}

describe("SPEC-MINUTKA-RESEARCH-TRACES-001: full tenant-scoped execution traces", () => {
  it("persists full successful trace data, preserves ordinary text, and redacts credential fixtures", async () => {
    const world = createInMemoryWorld(() => now);
    const profiles = await readyParticipant(world, "employee_a", "company_a", "group_a");
    const state = createInMemoryResearchTraceState();
    const traces = createInMemoryResearchTraceStore(state);
    const assistant = service({
      world, profiles, traces,
      runner: async () => ({
        text: "Готово для Анны и проекта Альфа.",
        executionTrace: [
          { kind: "process", processId: "evening_reflection" },
          { kind: "tool", toolName: "collectActivities" },
        ],
        usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25, llmSteps: 2 },
        trace: {
          model: "openai/test-model-2026-08-18",
          modelSteps: [{ text: "step", request: { body: { authorization: "Bearer super-secret", note: "Анна ведёт проект Альфа" } } }],
          toolCalls: [{ payload: { toolName: "collectActivities", args: { taskCategory: "reporting", inviteCode: "invite-secret" } } }],
          toolResults: [{ payload: { toolName: "collectActivities", result: { recorded: true, apiKey: "sk-secret-value" } } }],
        },
      }),
    });

    const result = await assistant.chat({ userId: "employee_a", threadId: "thread_a", text: "Анна ведёт проект Альфа" });
    const [trace] = await traces.list({ companyId: "company_a", groupId: "group_a" });

    expect(result.response).toContain("Анны");
    expect(trace).toMatchObject({
      schemaVersion: "research-trace/v1",
      traceId: "trace_1",
      requestId: "req_1",
      messageId: result.messageId,
      companyId: "company_a",
      groupId: "group_a",
      status: "completed",
      samplingRate: 1,
      processIds: ["core", "evening_reflection"],
      promptVersion: "prompt/v1",
      taxonomyVersion: "taxonomy/v1",
      output: "Готово для Анны и проекта Альфа.",
      usage: { totalTokens: 25 },
    });
    expect(trace?.input.text).toBe("Анна ведёт проект Альфа");
    expect(trace?.attempts[0]?.context).toContain("Personal assistant runtime context");
    expect(JSON.stringify(trace)).toContain("Анна ведёт проект Альфа");
    expect(JSON.stringify(trace)).not.toContain("super-secret");
    expect(JSON.stringify(trace)).not.toContain("invite-secret");
    expect(JSON.stringify(trace)).not.toContain("sk-secret-value");
    expect(JSON.stringify(trace)).toContain("[REDACTED]");
  });

  it("persists failed traces and keeps tenant-scoped JSON exports isolated", async () => {
    const world = createInMemoryWorld(() => now);
    const profilesA = await readyParticipant(world, "employee_a", "company_a", "group_a");
    await readyParticipant(world, "employee_b", "company_b", "group_b");
    const state = createInMemoryResearchTraceState();
    const traces = createInMemoryResearchTraceStore(state);
    const assistant = service({
      world, profiles: profilesA, traces,
      runner: async () => { throw Object.assign(new Error("provider timeout for Bearer hidden-token"), { code: "provider_timeout" }); },
    });

    await expect(assistant.chat({ userId: "employee_a", threadId: "thread_a", text: "Помоги" })).rejects.toThrow("provider timeout");
    const own = await traces.list({ companyId: "company_a", groupId: "group_a" });
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ status: "failed", error: { code: "provider_timeout", message: "provider timeout for Bearer [REDACTED]" } });
    expect(await traces.list({ companyId: "company_b", groupId: "group_b" })).toEqual([]);

    const exported = JSON.parse(exportResearchTracesJson({ companyId: "company_a", groupId: "group_a" }, own, now));
    expect(exported).toMatchObject({ schemaVersion: "research-trace-export/v1", traceCount: 1, scope: { companyId: "company_a", groupId: "group_a" } });
    expect(exported.traces[0].status).toBe("failed");
  });

  it("records denied and guard-failed turns so sampling covers every pilot run", async () => {
    const world = createInMemoryWorld(() => now);
    const profiles = await readyParticipant(world, "employee_a", "company_a", "group_a");
    const state = createInMemoryResearchTraceState();
    const traces = createInMemoryResearchTraceStore(state);
    const clock = { now: () => now };
    const documents = createInMemoryDocumentStore(clock);
    const denied = new AssistantService(async () => { throw new Error("agent must not run"); }, {
      documentStore: documents,
      conversationStore: createInMemoryConversationStore(world),
      ingestionService: createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock) }),
      requestIntegrityGuard: async () => ({ status: "denied", reason: "identity_substitution", usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } }),
      participantStore: profiles,
      researchTraceStore: traces,
      researchTraceVersions: versions,
      clock,
      idGenerator: createDeterministicIdGenerator(),
    });
    await expect(denied.chat({ userId: "employee_a", threadId: "thread_a", text: "Чужие данные" })).resolves.toMatchObject({ outcome: { status: "denied" } });
    expect(state.traces[0]).toMatchObject({ status: "completed", attempts: [{ context: "request_integrity_guard" }], usage: { totalTokens: 4 } });

    const failedState = createInMemoryResearchTraceState();
    const guardFailure = new AssistantService(async () => "unused", {
      documentStore: documents,
      conversationStore: createInMemoryConversationStore(world),
      ingestionService: createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock) }),
      requestIntegrityGuard: async () => { throw new Error("guard timeout"); },
      participantStore: profiles,
      researchTraceStore: createInMemoryResearchTraceStore(failedState),
      researchTraceVersions: versions,
      clock,
      idGenerator: createDeterministicIdGenerator(),
    });
    await expect(guardFailure.chat({ userId: "employee_a", threadId: "thread_b", text: "Проверка" })).rejects.toThrow("guard timeout");
    expect(failedState.traces[0]).toMatchObject({ status: "failed", error: { code: "Error", message: "guard timeout" } });
  });

  it("keeps the conversation durable and emits a visible drop signal when trace persistence fails", async () => {
    const world = createInMemoryWorld(() => now);
    const profiles = await readyParticipant(world, "employee_a", "company_a", "group_a");
    const warnings: unknown[] = [];
    const traces = createInMemoryResearchTraceStore(createInMemoryResearchTraceState(), { failAppend: () => true });
    const assistant = service({ world, profiles, traces, warnings, runner: async () => "Ответ сохранён." });

    await expect(assistant.chat({ userId: "employee_a", threadId: "thread_a", text: "Обычный разговор" })).resolves.toMatchObject({ response: "Ответ сохранён." });
    expect(world.messages).toHaveLength(1);
    expect(world.messages[0]).toMatchObject({ text: "Обычный разговор", response: "Ответ сохранён." });
    expect(warnings).toContainEqual(expect.objectContaining({ type: "research_trace_missing", status: "completed", reason: "Error" }));
    expect(world.auditEvents).toContainEqual(expect.objectContaining({ type: "trace_missing", metadata: { reason: "Error", status: "completed" } }));
  });
});
