import { describe, expect, it } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";
import { createInMemoryTaskMutationConfirmationStore } from "../../../src/application/in-memory-task-mutation-confirmation-store.js";
import { createInMemoryTaskStore } from "../../../src/application/in-memory-task-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { IdeaToTaskService } from "../../../src/application/idea-to-task.js";
import { createDeterministicIdGenerator } from "../../../src/application/runtime-primitives.js";
import { TaskMutationConfirmationService } from "../../../src/application/task-mutation-confirmation.js";
import { overflowAfterPendingActionUserMessage } from "../../../src/application/assistant-overflow-recovery.js";

const now = "2026-07-28T12:00:00.000Z";

function setup(runner: ConstructorParameters<typeof AssistantService>[0]) {
  const clock = { now: () => now };
  const world = createInMemoryWorld(clock.now);
  const documents = createInMemoryDocumentStore(clock);
  const ideas = createInMemoryIdeaStore(clock);
  const tasks = createInMemoryTaskStore(clock);
  const ingestion = createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock), ideaStore: ideas });
  const confirmations = new TaskMutationConfirmationService(
    createInMemoryTaskMutationConfirmationStore(tasks), clock,
    { confirmationId: (() => { let id = 0; return () => `tool-confirmation-${++id}`; })() },
  );
  const service = new AssistantService(runner, {
    documentStore: documents,
    conversationStore: createInMemoryConversationStore(world),
    ingestionService: ingestion,
    ideaStore: ideas,
    taskStore: tasks,
    taskMutations: confirmations,
    ideaToTask: new IdeaToTaskService(ideas, tasks, confirmations),
    requestIntegrityGuard: async () => ({ status: "allowed" }),
    clock,
    idGenerator: createDeterministicIdGenerator(),
  });
  return { service, confirmations, tasks, ideas };
}

describe("SPEC-PERSONAL-ASSISTANT-TASK-TOOLS-001: owner-bound task proposals", () => {
  it("returns one safe typed pending action without mutating a task", async () => {
    let modelVisible: unknown;
    const { service, confirmations, tasks } = setup(async (_input, context) => {
      modelVisible = await context.tasks.propose({ kind: "create", title: "Prepare launch", project: "ASSISTANT", type: "operations", dueDate: "2026-07-30" });
      return "Предложение готово";
    });

    const result = await service.chat({ userId: "owner", threadId: "telegram:owner", text: "create task" });
    expect(result).toMatchObject({
      response: "Предложение готово",
      pendingAction: { confirmationId: "tool-confirmation-1", actionKind: "create", summary: "Создать задачу: Prepare launch", expiresAt: expect.any(String) },
    });
    expect(result.pendingAction).not.toHaveProperty("ownerId");
    expect(result.pendingAction).not.toHaveProperty("proposal");
    expect(result.pendingAction).not.toHaveProperty("payloadDigest");
    await expect(tasks.list("owner")).resolves.toEqual([]);
    expect(modelVisible).toMatchObject({ ownerId: "owner", proposal: { kind: "create", input: { id: "task_1", status: "open" } } });

    await expect(confirmations.confirm("owner", result.pendingAction!.confirmationId)).resolves.toMatchObject({ status: "confirmed" });
    await expect(tasks.list("owner")).resolves.toMatchObject([{ id: "task_1", title: "Prepare launch", userId: "owner", status: "open" }]);
  });

  it("returns a persisted proposal without retrying when the provider overflows after proposal creation", async () => {
    let calls = 0;
    const { service, tasks } = setup(async (_input, context) => {
      calls += 1;
      await context.tasks.propose({ kind: "create", title: "Overflow proposal", project: "ASSISTANT", type: "operations" });
      throw new Error("maximum context length exceeded");
    });

    await expect(service.chat({ userId: "owner", threadId: "thread", text: "create safely" })).resolves.toMatchObject({
      response: overflowAfterPendingActionUserMessage,
      pendingAction: { confirmationId: "tool-confirmation-1", summary: "Создать задачу: Overflow proposal" },
      effect: "pending_action_created",
    });
    expect(calls).toBe(1);
    await expect(tasks.list("owner")).resolves.toEqual([]);
  });

  it("rejects a second proposal in the same assistant turn deterministically", async () => {
    const { service, tasks } = setup(async (_input, context) => {
      await context.tasks.propose({ kind: "create", title: "First", project: "ASSISTANT", type: "operations" });
      await context.tasks.propose({ kind: "create", title: "Second", project: "ASSISTANT", type: "operations" });
      return "unreachable";
    });

    await expect(service.chat({ userId: "owner", threadId: "thread", text: "two tasks" })).rejects.toThrow("only one task proposal is allowed per assistant turn");
    await expect(tasks.list("owner")).resolves.toEqual([]);
  });

  it("prevents an adversarial agent from confirming inside the same tool loop", async () => {
    let exposedKeys: string[] = [];
    const { service, tasks } = setup(async (_input, context) => {
      exposedKeys = Object.keys(context.tasks).sort();
      const pending = await context.tasks.propose({ kind: "create", title: "Bypass attempt", project: "ASSISTANT", type: "operations" });
      expect((context.tasks as unknown as { confirm?: unknown }).confirm).toBeUndefined();
      return pending.confirmationId;
    });

    await expect(service.chat({ userId: "owner", threadId: "thread", text: "propose and confirm" })).resolves.toMatchObject({
      pendingAction: { confirmationId: "tool-confirmation-1" },
    });
    expect(exposedKeys).toEqual(["list", "propose", "proposeIdeaToTask"]);
    await expect(tasks.list("owner")).resolves.toEqual([]);
  });

  it("binds task reads and idea provenance to the authenticated owner", async () => {
    const { service, tasks, ideas } = setup(async (_input, context) => {
      const listed = await context.tasks.list({ order: "created_asc" });
      const conversion = await context.tasks.proposeIdeaToTask("idea-owner");
      return JSON.stringify({ ids: listed.map(({ id }) => id), conversion });
    });
    await tasks.create("owner", { id: "task-owner", title: "Visible", project: "ASSISTANT", type: "operations", status: "open" });
    await tasks.create("other", { id: "task-other", title: "Private", project: "OTHER", type: "personal", status: "open" });
    await ideas.add({ id: "idea-owner", userId: "owner", project: "ASSISTANT", type: "development", summary: "Convert me", status: "raw" });

    const result = await service.chat({ userId: "owner", threadId: "thread", text: "list and convert" });
    const parsed = JSON.parse(result.response) as { ids: string[]; conversion: { status: string } };
    expect(parsed.ids).toEqual(["task-owner"]);
    expect(parsed.conversion).toMatchObject({ status: "needs_confirmation" });
    expect(result.pendingAction).toMatchObject({ actionKind: "idea_to_task", summary: "Создать задачу из идеи: Convert me" });
    await expect(tasks.getByOriginIdeaId("owner", "idea-owner")).resolves.toBeNull();
  });
});
