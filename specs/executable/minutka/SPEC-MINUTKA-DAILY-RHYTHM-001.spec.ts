import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { createAssistantAgentRunner } from "../../../src/mastra/agent-runner.js";
import { CollectActivityService } from "../../../src/application/activity-collection.js";
import { createInMemoryActivityCollectionState, createInMemoryActivityCollectionStore } from "../../../src/application/in-memory-activity-collection-store.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryFeedbackStore } from "../../../src/application/in-memory-feedback-store.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";
import { createInMemoryInsightStore } from "../../../src/application/in-memory-insight-store.js";
import { createInMemoryProfileStore } from "../../../src/application/in-memory-profile-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { createRuntimeProjectionBuilder } from "../../../src/application/runtime-projections/runtime-projection-builder.js";

function harness(runner: ConstructorParameters<typeof AssistantService>[0]) {
  const clock = { now: () => "2026-08-15T07:00:00.000Z" };
  const world = createInMemoryWorld(clock.now);
  world.participants.push({
    employeeId: "employee_a", companyId: "company_a", groupId: "group_a", subjectKey: "subject_employee_a",
    roleId: "role_a", status: "profile_completed", createdAt: clock.now(), updatedAt: clock.now(),
  });
  world.profiles.push({
    employeeId: "employee_a", companyId: "company_a", groupId: "group_a", roleId: "role_a",
    preferredName: "Employee", assistantName: "Assistant", addressForm: "informal", persona: "efficiency",
    responseLength: "short", timezone: "Europe/Moscow", createdAt: clock.now(), updatedAt: clock.now(),
  });
  const documents = createInMemoryDocumentStore(clock);
  const ideas = createInMemoryIdeaStore(clock);
  const conversationStore = createInMemoryConversationStore(world);
  const state = createInMemoryActivityCollectionState();
  const activities = new CollectActivityService(createInMemoryActivityCollectionStore(state), clock, (() => {
    let index = 0;
    return () => `activity_${++index}`;
  })());
  const profiles = createInMemoryProfileStore(world);
  const service = new AssistantService(runner, {
    documentStore: documents,
    conversationStore,
    ideaStore: ideas,
    ingestionService: createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock), ideaStore: ideas }),
    participantStore: profiles,
    chatProjectionBuilder: createRuntimeProjectionBuilder({
      profileStore: profiles,
      conversationStore,
      insightStore: createInMemoryInsightStore(world),
      feedbackStore: createInMemoryFeedbackStore(world),
      auditEventStore: createInMemoryAuditEventStore(world),
      clock,
    }),
    collectActivities: (command) => activities.collectBatch(command),
    requestIntegrityGuard: async () => ({ status: "allowed" }),
    clock,
  });
  return { service, state, conversationStore };
}

describe("SPEC-MINUTKA-DAILY-RHYTHM-001: morning plan, voluntary midday update, evening fact", () => {
  it("keeps morning planning read-only and returns at most three priorities plus one first step", async () => {
    let activityCalls = 0;
    const { service, state } = harness(async (_input, context) => {
      context.markProcessUsed("morning_planning");
      expect(context.profileAndHistory.thread.data.turns).toEqual([]);
      activityCalls += state.activities.length;
      return { text: "1. Сверить цифры\n2. Подготовить встречу\n3. Ответить поставщику\nПервый шаг: открыть таблицу и проверить итог.", executionTrace: [] };
    });

    const result = await service.chat({
      userId: "employee_a", threadId: "daily", text: "Что важно сделать сегодня?", requiredProcessId: "morning_planning",
    });

    expect(result.selectedProcessIds).toEqual(["core", "morning_planning"]);
    expect(result.effect).toBe("none");
    expect(result.response.split("\n")).toHaveLength(4);
    expect(activityCalls).toBe(0);
    expect(state.activities).toEqual([]);
  });

  it("uses bounded morning history for a voluntary chat-only midday adjustment without a schedule", async () => {
    const { service, state } = harness(async (input, context) => {
      if (input.text.startsWith("План:")) {
        context.markProcessUsed("morning_planning");
        return "Приоритеты: отчёт и встреча. Первый шаг: открыть таблицу.";
      }
      context.markProcessUsed("midday_adjustment");
      expect(context.profileAndHistory.thread.data.turns.at(-1)?.agentResponse).toContain("отчёт и встреча");
      return "Встреча сдвинулась: оставьте отчёт и согласование. Первый шаг: закончить сводную таблицу.";
    });

    await service.chat({ userId: "employee_a", threadId: "daily", text: "План: отчёт и встреча", requiredProcessId: "morning_planning" });
    const result = await service.chat({ userId: "employee_a", threadId: "daily", text: "Встречу перенесли, как перестроиться?" });

    expect(result.selectedProcessIds).toEqual(["core", "midday_adjustment"]);
    expect(result.effect).toBe("none");
    expect(state.activities).toEqual([]);
  });

  it("records more than three structured activities through one registered Mastra tool call", async () => {
    let toolCalls = 0;
    const { service, state } = harness(createAssistantAgentRunner({
      async generate(_text, options) {
        const tool = options.toolsets.activities.collectActivities as { execute(input: unknown, context: unknown): Promise<unknown> };
        toolCalls += 1;
        await expect(tool.execute({ activities: [
          { taskCategory: "meetings", durationBucket: "30_60m", system: "messengers" },
          { taskCategory: "reporting", routinePattern: "manual_reporting", system: "spreadsheets" },
          { taskCategory: "coordination" },
          { taskCategory: "focus_work", automationCandidate: "data_entry_reduction" },
          { taskCategory: "communication", energyStressMarker: "focus_loss" },
        ] }, {})).resolves.toEqual({ status: "completed", savedCount: 5 });
        return { text: "Записал пять фактических активностей.", toolCalls: [], toolResults: [] };
      },
    }));

    const result = await service.chat({
      userId: "employee_a", threadId: "daily",
      text: "Провёл планёрку, свёл отчёт, начал согласование, разобрал данные и ответил коллегам.", requiredProcessId: "evening_reflection",
    });

    expect(result.selectedProcessIds).toEqual(["core", "evening_reflection"]);
    expect(result.effect).toBe("business_write_committed");
    expect(toolCalls).toBe(1);
    expect(state.activities).toHaveLength(5);
    expect(state.activities[2]).toMatchObject({ taskCategory: "coordination", activityDate: "2026-08-15" });
    expect(state.activities[2]).not.toHaveProperty("durationBucket");
    expect(state.activities[2]).not.toHaveProperty("system");
  });

  it("offers a missed-evening catch-up, records only a new factual activity, and then returns to planning", async () => {
    const { service, state } = harness(async (input, context) => {
      const history = context.profileAndHistory.thread.data.turns;
      if (input.text === "Отчёт завершил") {
        context.markProcessUsed("evening_reflection");
        await context.collectActivities({ activities: [{ taskCategory: "reporting" }] });
        return "Записал отчёт.";
      }
      if (input.text === "Вечернее сообщение") {
        context.markProcessUsed("evening_reflection");
        return "Что получилось сделать или начать сегодня?";
      }
      if (input.text === "Утро после пропуска") {
        context.markProcessUsed("morning_planning");
        expect(history.at(-1)?.agentResponse).toContain("Что получилось сделать");
        return "Коротко: что вчера действительно сделали или начали? После этого выберем план на сегодня.";
      }
      context.markProcessUsed("morning_planning");
      expect(history.some((turn) => turn.agentResponse.includes("Записал отчёт"))).toBe(true);
      await context.collectActivities({ activities: [{ taskCategory: "coordination" }] });
      return "Записал только новое согласование. Сегодня: 1) завершить согласование; 2) проверить отчёт. Первый шаг: открыть последнее письмо.";
    });

    await service.chat({ userId: "employee_a", threadId: "daily", text: "Отчёт завершил", requiredProcessId: "evening_reflection" });
    await service.chat({ userId: "employee_a", threadId: "daily", text: "Вечернее сообщение", requiredProcessId: "evening_reflection" });
    const prompt = await service.chat({ userId: "employee_a", threadId: "daily", text: "Утро после пропуска", requiredProcessId: "morning_planning" });
    const result = await service.chat({ userId: "employee_a", threadId: "daily", text: "Отчёт уже записан, ещё начал согласование", requiredProcessId: "morning_planning" });

    expect(prompt.response).toContain("что вчера действительно сделали");
    expect(result.selectedProcessIds).toEqual(["core", "morning_planning"]);
    expect(state.activities).toEqual([
      expect.objectContaining({ taskCategory: "reporting" }),
      expect.objectContaining({ taskCategory: "coordination" }),
    ]);
  });

  it("keeps task and project tools outside the active daily rhythm", () => {
    const activeTools = JSON.parse(readFileSync("vault/assistant/bin/registry.json", "utf8")) as { personalAssistant: Array<{ id: string }> };
    const joinedProcesses = [
      readFileSync("vault/assistant/processes/morning_planning.md", "utf8"),
      readFileSync("vault/assistant/processes/midday_adjustment.md", "utf8"),
      readFileSync("vault/assistant/processes/evening_reflection.md", "utf8"),
    ].join("\n");

    expect(activeTools.personalAssistant.map(({ id }) => id)).not.toEqual(expect.arrayContaining([
      "listTasks", "proposeTaskMutation", "proposeIdeaToTask", "listProjects",
    ]));
    expect(joinedProcesses).toContain("Do not use task, project");
  });
});
