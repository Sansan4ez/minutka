import { Agent } from "@mastra/core/agent";
import { describe, expect, it } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { CollectActivityService } from "../../../src/application/activity-collection.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryActivityCollectionState, createInMemoryActivityCollectionStore } from "../../../src/application/in-memory-activity-collection-store.js";
import { createInMemoryProfileStore } from "../../../src/application/in-memory-profile-store.js";
import { createInMemoryResearchTraceState, createInMemoryResearchTraceStore } from "../../../src/application/in-memory-research-trace-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { createDeterministicIdGenerator } from "../../../src/application/runtime-primitives.js";
import { exportResearchTracesJson } from "../../../src/application/research-trace-store.js";
import { createAssistantAgentRunner } from "../../../src/mastra/agent-runner.js";
import { createInMemoryUsageStore } from "../../../src/application/in-memory-usage-store.js";

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
  usageStore?: ReturnType<typeof createInMemoryUsageStore>;
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
    ...(input.usageStore ? {
      usageStore: input.usageStore,
      usageCostPolicy: {
        monthlySoftLimitUsdMicros: 1_000_000,
        inputUsdMicrosPerMillionTokens: 1,
        cachedInputUsdMicrosPerMillionTokens: 1,
        outputUsdMicrosPerMillionTokens: 1,
      },
    } : {}),
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

  it("keeps a combined-facet ordinary activity and trace durable without updating confirmed profile context", async () => {
    const world = createInMemoryWorld(() => now);
    const profiles = await readyParticipant(world, "employee_a", "company_a", "group_a");
    const traceState = createInMemoryResearchTraceState();
    const traces = createInMemoryResearchTraceStore(traceState);
    const activityState = createInMemoryActivityCollectionState();
    const activities = new CollectActivityService(
      createInMemoryActivityCollectionStore(activityState),
      { now: () => now },
      () => "activity_recovered",
    );
    let modelStep = 0;
    const model = {
      specificationVersion: "v2",
      provider: "scripted-trace-recovery",
      modelId: "scripted-trace-recovery",
      supportedUrls: {},
      async doGenerate() {
        modelStep += 1;
        const base = {
          rawCall: { rawPrompt: null, rawSettings: {} },
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        };
        if (modelStep === 1) return {
          ...base,
          finishReason: "tool-calls",
          content: [{
            type: "tool-call", toolCallId: "activity", toolName: "processCurrentActivityTurn",
            input: JSON.stringify({ mode: "record" }),
          }],
        };
        return { ...base, finishReason: "stop", content: [{ type: "text", text: "Активность записана." }] };
      },
      async doStream() { throw new Error("streaming is not used"); },
    } as never;
    const usageStore = createInMemoryUsageStore();
    const ordinaryActivityAssistant = new AssistantService(createAssistantAgentRunner(new Agent({
      id: "trace-recovery",
      name: "trace-recovery",
      instructions: "Use only the activity transaction for an ordinary factual activity turn.",
      model,
      tools: {},
      editor: false,
    })), {
      documentStore: createInMemoryDocumentStore({ now: () => now }),
      conversationStore: createInMemoryConversationStore(world),
      ingestionService: createIngestionService({ documentStore: createInMemoryDocumentStore({ now: () => now }), blobStore: createInMemoryBlobStore({ now: () => now }) }),
      requestIntegrityGuard: async () => ({ status: "allowed" }),
      participantStore: profiles,
      processCurrentActivityTurn: async (command) => {
        const result = await activities.collectBatch({
          employeeId: command.employeeId,
          companyId: command.companyId,
          groupId: command.groupId,
          subjectKey: command.subjectKey,
          sourceMessageId: command.sourceMessageId,
          roleId: command.roleId,
          timezone: command.timezone,
          activities: [{
            taskCategory: "reporting",
            durationBucket: "30_60m",
            system: "spreadsheets",
            routinePattern: "manual_reporting",
            automationCandidate: "template_or_checklist",
            energyStressMarker: "fatigue",
          }],
        });
        if (result.status !== "completed") throw new Error("expected completed collection");
        return {
          ...result,
          operation: "collect" as const,
          extraction: {
            context: { currentTextCharacters: command.currentText.length, staticRulesCharacters: 10, durationReferencesCharacters: 10, recentCandidatesCharacters: 0, promptCharacters: command.currentText.length + 20 },
            decision: {
              kind: "collect",
              activities: [{
                taskCategory: "reporting",
                durationRef: "duration_1",
                system: "spreadsheets",
                routinePattern: "manual_reporting",
                automationCandidate: "template_or_checklist",
                energyStressMarker: "fatigue",
              }],
            },
            usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9, cachedInputTokens: 3, llmSteps: 1 },
            trace: {
              promptVersion: "minutka-activity-transaction/v1",
              model: "openai/activity-transaction-test",
              boundedContext: "bounded current employee message invite_code=secret-value",
              modelSteps: [{ request: { authorization: "Bearer activity-secret" } }],
              latencyMs: 12,
            },
            latencyMs: 14,
          },
        };
      },
      collectActivities: (command) => activities.collectBatch(command),
      researchTraceStore: traces,
      researchTraceVersions: versions,
      usageStore,
      usageCostPolicy: {
        monthlySoftLimitUsdMicros: 1_000_000,
        inputUsdMicrosPerMillionTokens: 1,
        cachedInputUsdMicrosPerMillionTokens: 1,
        outputUsdMicrosPerMillionTokens: 1,
      },
      clock: { now: () => now },
      idGenerator: createDeterministicIdGenerator(),
    });

    const result = await ordinaryActivityAssistant.chat({
      userId: "employee_a",
      threadId: "thread_recovery",
      text: "35 минут вручную готовил еженедельный отчёт в Excel; это повторяющаяся рутина, её стоит автоматизировать, и я сильно вымотался.",
      requiredProcessId: "evening_reflection",
    });
    const [trace] = await traces.list({ companyId: "company_a", groupId: "group_a" });

    expect(world.messages).toEqual([expect.objectContaining({
      id: result.messageId,
      text: "35 минут вручную готовил еженедельный отчёт в Excel; это повторяющаяся рутина, её стоит автоматизировать, и я сильно вымотался.",
    })]);
    expect(activityState.activities).toEqual([expect.objectContaining({
      activityId: "activity_recovered",
      employeeId: "employee_a",
      companyId: "company_a",
      groupId: "group_a",
      subjectKey: expect.any(String),
      taskCategory: "reporting",
      durationBucket: "30_60m",
      system: "spreadsheets",
      routinePattern: "manual_reporting",
      automationCandidate: "template_or_checklist",
      energyStressMarker: "fatigue",
    })]);
    expect((await profiles.getProfile("employee_a"))?.typicalTasks).toBeUndefined();
    expect(world.auditEvents.filter((event) => event.type === "profile_updated")).toEqual([]);
    expect(trace).toMatchObject({ messageId: result.messageId, status: "completed", companyId: "company_a", groupId: "group_a" });
    expect(trace?.attempts[0]?.contour).toBe("main_agent");
    expect(trace?.attempts[0]?.toolCalls).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ toolName: "processCurrentActivityTurn" }) }),
    ]);
    expect(trace?.attempts[0]?.toolResults).toHaveLength(1);
    expect(JSON.stringify(trace?.attempts[0]?.toolCalls)).not.toContain("updatePersonalContext");
    expect(trace?.attempts[1]).toMatchObject({
      contour: "activity_transaction",
      promptVersion: "minutka-activity-transaction/v1",
      model: "openai/activity-transaction-test",
      decision: {
        kind: "collect",
        activities: [{
          taskCategory: "reporting",
          durationRef: "duration_1",
          system: "spreadsheets",
          routinePattern: "manual_reporting",
          automationCandidate: "template_or_checklist",
          energyStressMarker: "fatigue",
        }],
      },
      mutationResult: { status: "completed", operation: "collect", savedCount: 1, activityIds: ["activity_recovered"] },
      usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9, cachedInputTokens: 3, llmSteps: 1 },
      latencyMs: 14,
    });
    expect(trace?.attempts[1]?.context).toContain("bounded current employee message");
    expect(JSON.stringify(trace)).toContain("processCurrentActivityTurn");
    expect(JSON.stringify(trace)).toContain("taskCategory");
    expect(JSON.stringify(trace)).not.toContain("secret-value");
    expect(JSON.stringify(trace)).not.toContain("activity-secret");
    expect(await usageStore.listRecords()).toEqual(expect.arrayContaining([
      expect.objectContaining({ requestId: trace?.requestId, source: "activity_transaction", totalTokens: 9 }),
    ]));
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
    expect(state.traces[0]).toMatchObject({ status: "completed", attempts: [{ contour: "request_integrity_guard", context: "request_integrity_guard", usage: { totalTokens: 4 } }], usage: { totalTokens: 4 } });

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
