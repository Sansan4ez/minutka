import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { CollectActivityService } from "../../../src/application/activity-collection.js";
import { createInMemoryActivityCollectionState, createInMemoryActivityCollectionStore } from "../../../src/application/in-memory-activity-collection-store.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryProfileStore } from "../../../src/application/in-memory-profile-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { PersistenceError, PersistenceOutcomeUnknownError } from "../../../src/application/persistence-error.js";

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
    ingestionService: createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock) }),
    participantStore: createInMemoryProfileStore(world),
    collectActivity: options.collectActivity ?? ((command) => activityCollection.collect(command)),
    requestIntegrityGuard: async () => ({ status: "allowed" }),
    clock,
  });
  return { service, state, world, conversationStore };
}

describe("SPEC-MINUTKA-MORNING-ACTIVITY-COLLECTION-001: morning collection process", () => {
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
    expect(state.personalActivities).toHaveLength(3);
    expect(state.anonymizedActivities).toHaveLength(3);
    expect(state.anonymizedActivities[2]).toEqual({
      companyId: "company_a",
      groupId: "group_a",
      roleId: "role_a",
      taskCategory: "coordination",
      date: "2026-08-15",
    });
    expect(state.anonymizedActivities[2]).not.toHaveProperty("durationBucket");
    expect(state.anonymizedActivities[2]).not.toHaveProperty("system");
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

  it("keeps the free employee account in private conversation history and out of anonymized rows", async () => {
    const { service, state, conversationStore } = harness();
    const story = "Меня раздражало ждать согласование от Ирины, потом я вручную сводил цифры.";

    await service.chat({ userId: "employee_a", threadId: "thread_a", text: story });

    await expect(conversationStore.getRecentTurns({ employeeId: "employee_a", threadId: "thread_a", limit: 1 }))
      .resolves.toMatchObject([{ userText: story }]);
    expect(JSON.stringify(state.anonymizedActivities)).not.toContain("Ирины");
    expect(JSON.stringify(state.anonymizedActivities)).not.toContain("раздражало");
    expect(JSON.stringify(state.anonymizedActivities)).not.toContain("вручную сводил цифры");
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
    expect(defaults).toContain('{ processId: "morning_activity_collection", timeOfDay: "09:00" }');
    expect(defaults).not.toContain('{ processId: "day_focus", timeOfDay: "09:00" }');
    expect(process).toContain("Call `collectActivity` exactly once for each named activity");
    expect(process).toContain("Put the activity category and its obstacle in the same call");
    expect(process).toContain("If duration, system, category, or obstacle is unknown, omit it");
    expect(process).toContain("The application keeps the full employee message in the private conversation record");
  });
});
