import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { CollectActivityService } from "../../../src/application/activity-collection.js";
import { createInMemoryActivityCollectionState, createInMemoryActivityCollectionStore } from "../../../src/application/in-memory-activity-collection-store.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";
import { createInMemoryProfileStore } from "../../../src/application/in-memory-profile-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { PersistenceError, PersistenceOutcomeUnknownError } from "../../../src/application/persistence-error.js";
import { createAssistantAgentRunner, type MastraAgentLike } from "../../../src/mastra/agent-runner.js";

function harness(options: {
  collectActivity?: (command: Parameters<CollectActivityService["collect"]>[0]) => Promise<{ activityId: string }>;
  runner?: ConstructorParameters<typeof AssistantService>[0];
} = {}) {
  const clock = { now: () => "2026-08-15T07:00:00.000Z" };
  const world = createInMemoryWorld(clock.now);
  world.participants.push({
    employeeId: "employee_a",
    companyId: "company_a",
    groupId: "group_a",
    subjectKey: "subject_employee_a",
    roleId: "role_a",
    status: "profile_completed",
    createdAt: clock.now(),
    updatedAt: clock.now(),
  });
  world.profiles.push({
    employeeId: "employee_a",
    companyId: "company_a",
    groupId: "group_a",
    roleId: "role_a",
    preferredName: "Employee",
    assistantName: "Assistant",
    addressForm: "informal",
    persona: "efficiency",
    responseLength: "short",
    timezone: "Europe/Moscow",
    createdAt: clock.now(),
    updatedAt: clock.now(),
  });
  const documents = createInMemoryDocumentStore(clock);
  const ideas = createInMemoryIdeaStore(clock);
  const conversationStore = createInMemoryConversationStore(world);
  const state = createInMemoryActivityCollectionState();
  const activityCollection = new CollectActivityService(
    createInMemoryActivityCollectionStore(state),
    clock,
    (() => {
      let index = 0;
      return () => `activity_${++index}`;
    })(),
  );
  const service = new AssistantService(options.runner ?? (async (_input, context) => {
    context.markProcessUsed("morning_activity_collection");
    await context.collectActivity({ taskCategory: "meetings", durationBucket: "30_60m", system: "messengers" });
    await context.collectActivity({ taskCategory: "reporting", routinePattern: "manual_reporting", durationBucket: "1_2h", system: "spreadsheets" });
    await context.collectActivity({ taskCategory: "coordination" });
    return { text: "Записал три активности.", executionTrace: [] };
  }), {
    documentStore: documents,
    conversationStore,
    // Wired exactly as production is, so a touch that records nothing would be
    // free to reach idea capture and surface as inbox_capture.
    ideaStore: ideas,
    ingestionService: createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock), ideaStore: ideas }),
    participantStore: createInMemoryProfileStore(world),
    collectActivity: options.collectActivity ?? ((command) => activityCollection.collect(command)),
    requestIntegrityGuard: async () => ({ status: "allowed" }),
    clock,
  });
  return { service, state, world, conversationStore, ideas };
}

describe("SPEC-MINUTKA-MORNING-ACTIVITY-COLLECTION-001: morning collection process", () => {
  it("records every inbound touch on the profile-local calendar day, even without an activity write", async () => {
    const { service, world } = harness({ runner: async () => ({ text: "Расскажите подробнее.", executionTrace: [] }) });

    await service.chat({ userId: "employee_a", threadId: "thread_a", text: "Сегодня просто хочу уточнить вопрос." });

    expect(world.participants[0]?.lastTouchOn).toBe("2026-08-15");
  });

  it("records one typed action for each of three named activities and keeps missing values empty", async () => {
    const { service, state } = harness();

    const result = await service.chat({
      userId: "employee_a",
      threadId: "thread_a",
      text: "Сначала была планёрка, потом делал сводку в таблицах, а после согласовывал поставку.",
      requiredProcessId: "morning_activity_collection",
    });

    expect(result.selectedProcessIds).toEqual(["core", "morning_activity_collection"]);
    expect(result.effect).toBe("business_write_committed");
    expect(state.activities).toHaveLength(3);
    expect(state.activities[2]).toMatchObject({
      employeeId: "employee_a",
      subjectKey: "subject_employee_a",
      companyId: "company_a",
      groupId: "group_a",
      roleId: "role_a",
      taskCategory: "coordination",
      activityDate: "2026-08-15",
    });
    expect(state.activities[2]).not.toHaveProperty("durationBucket");
    expect(state.activities[2]).not.toHaveProperty("system");
  });

  it("records the activities through the registered provider tool instead of losing the touch to the capture gate", async () => {
    // Replays the daily touch at the seam the pilot run failed on: the model
    // speaks to the registered Mastra tool, not to the application closure, so
    // tool input validation runs on arguments in the shape a provider emits.
    const toolResults: unknown[] = [];
    const agent: MastraAgentLike = {
      async generate(_text, options) {
        const invocation = { toolCallId: "tool-call-1", messages: [] };
        const tool = (toolset: string, name: string) =>
          (options.toolsets as Record<string, Record<string, { execute: (input: unknown, context: unknown) => Promise<unknown> }>>)[toolset]![name]!;

        await tool("diagnostics", "markProcessUsed").execute({ id: "morning_activity_collection" }, invocation);
        for (const activity of [
          // The model classifies the same obstacle through every lens it was
          // offered; the touch must survive that instead of being rejected.
          {
            taskCategory: "reporting",
            routinePattern: "manual_reporting",
            automationCandidate: "report_generation",
            energyStressMarker: "neutral",
            durationBucket: "30_60m",
            system: "one_c",
          },
          { taskCategory: "meetings", durationBucket: "15_30m", system: "messengers" },
          { taskCategory: "coordination" },
        ]) {
          toolResults.push(await tool("activities", "collectActivity").execute(activity, invocation));
        }
        return { text: "Записал три активности." };
      },
    };
    const { service, state, ideas } = harness({ runner: createAssistantAgentRunner(agent) });

    const result = await service.chat({
      userId: "employee_a",
      threadId: "thread_a",
      text: "Полдня сводил отчёт в 1С вручную, была планёрка в мессенджере, потом согласовывал поставку.",
    });

    expect(toolResults).toEqual([{ recorded: true }, { recorded: true }, { recorded: true }]);
    expect(result.selectedProcessIds).toEqual(["core", "morning_activity_collection"]);
    expect(result.effect).toBe("business_write_committed");
    expect(result.response).toBe("Записал три активности.");
    await expect(ideas.list("employee_a")).resolves.toEqual([]);
    expect(state.activities).toEqual([
      expect.objectContaining({
        employeeId: "employee_a",
        subjectKey: "subject_employee_a",
        taskCategory: "reporting",
        obstacle: { kind: "routine_pattern", value: "manual_reporting" },
        durationBucket: "30_60m",
        system: "one_c",
        activityDate: "2026-08-15",
      }),
      expect.objectContaining({
        employeeId: "employee_a",
        subjectKey: "subject_employee_a",
        taskCategory: "meetings",
        durationBucket: "15_30m",
        system: "messengers",
        activityDate: "2026-08-15",
      }),
      expect.objectContaining({ taskCategory: "coordination", activityDate: "2026-08-15" }),
    ]);
    expect(state.activities).toHaveLength(3);
  });

  it("reports a rolled-back storage failure as an ordinary retryable save error", async () => {
    const failure = new PersistenceError("persistence_conflict");
    const { service } = harness({
      runner: async (_input, context) => {
        await context.collectActivity({ taskCategory: "reporting" });
        return "unreachable";
      },
      collectActivity: async () => { throw failure; },
    });

    await expect(service.chat({ userId: "employee_a", threadId: "thread_a", text: "Запиши отчёт." })).rejects.toBe(failure);
  });

  it("keeps outcome_unknown when the activity transaction commit cannot be observed", async () => {
    const { service } = harness({
      runner: async (_input, context) => {
        try {
          await context.collectActivity({ taskCategory: "reporting" });
        } catch {
          return "tool error was swallowed";
        }
        return "unreachable";
      },
      collectActivity: async () => { throw new PersistenceOutcomeUnknownError(); },
    });

    await expect(service.chat({ userId: "employee_a", threadId: "thread_a", text: "Запиши отчёт." })).rejects.toMatchObject({
      name: "AssistantMutationOutcomeUnknownError",
      code: "mutation_outcome_unknown",
    });
  });

  it("keeps free text in conversation history and out of structured canonical activities", async () => {
    const { service, state, conversationStore } = harness();
    const story = "Меня раздражало ждать согласование от Ирины, потом я вручную сводил цифры.";

    await service.chat({ userId: "employee_a", threadId: "thread_a", text: story });

    await expect(conversationStore.getRecentTurns({ employeeId: "employee_a", threadId: "thread_a", limit: 1 }))
      .resolves.toMatchObject([{ userText: story }]);
    expect(JSON.stringify(state.activities)).not.toContain("Ирины");
    expect(JSON.stringify(state.activities)).not.toContain("раздражало");
    expect(JSON.stringify(state.activities)).not.toContain("вручную сводил цифры");
  });

  it("registers the process and makes it the default morning touch instead of day_focus", () => {
    const registry = JSON.parse(readFileSync("vault/assistant/processes/registry.json", "utf8")) as {
      processes: Array<{ id: string; path: string }>;
    };
    const defaults = readFileSync("src/application/default-schedules.ts", "utf8");
    const process = readFileSync("vault/assistant/processes/morning_activity_collection.md", "utf8");

    expect(registry.processes).toContainEqual(expect.objectContaining({
      id: "morning_activity_collection",
      path: "vault/assistant/processes/morning_activity_collection.md",
    }));
    expect(defaults).toContain('{ processId: "morning_activity_collection", timeOfDay: "08:30", daysOfWeek: 31 }');
    expect(defaults).not.toContain('{ processId: "day_focus",');
    expect(process).toContain("Call `collectActivity` exactly once for each named activity");
    expect(process).toContain("Put the activity category and its obstacle in the same call");
    expect(process).toContain("If duration, system, category, or obstacle is unknown, omit it");
    expect(process).toContain("The application keeps the full employee message in the private conversation record");
  });
});
