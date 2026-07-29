import { describe, expect, it } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
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
import { TaskMutationConfirmationService, type TaskMutationConfirmationStore } from "../../../src/application/task-mutation-confirmation.js";
import { overflowAfterPendingActionUserMessage } from "../../../src/application/assistant-overflow-recovery.js";

const now = "2026-07-28T12:00:00.000Z";

function setup(
  runner: ConstructorParameters<typeof AssistantService>[0],
  options: { wrapConfirmationStore?: (store: TaskMutationConfirmationStore) => TaskMutationConfirmationStore; exposeIdeaStore?: boolean } = {},
) {
  const clock = { now: () => now };
  const world = createInMemoryWorld(clock.now);
  const documents = createInMemoryDocumentStore(clock);
  const ideas = createInMemoryIdeaStore(clock);
  const tasks = createInMemoryTaskStore(clock);
  const ingestion = createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock), ideaStore: ideas });
  const baseConfirmationStore = createInMemoryTaskMutationConfirmationStore(tasks);
  const confirmationStore = options.wrapConfirmationStore?.(baseConfirmationStore) ?? baseConfirmationStore;
  const auditEventStore = createInMemoryAuditEventStore(world);
  const confirmations = new TaskMutationConfirmationService(
    confirmationStore, clock,
    {
      confirmationId: (() => { let id = 0; return () => `tool-confirmation-${++id}`; })(),
      auditEventStore,
      idGenerator: createDeterministicIdGenerator(),
    },
  );
  const service = new AssistantService(runner, {
    documentStore: documents,
    conversationStore: createInMemoryConversationStore(world),
    ingestionService: ingestion,
    ...(options.exposeIdeaStore === false ? {} : { ideaStore: ideas }),
    taskStore: tasks,
    taskMutations: confirmations,
    ideaToTask: new IdeaToTaskService(ideas, tasks, confirmations),
    auditEventStore,
    requestIntegrityGuard: async () => ({ status: "allowed" }),
    clock,
    idGenerator: createDeterministicIdGenerator(),
  });
  return { service, confirmations, tasks, ideas, world };
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
    expect(modelVisible).toEqual(result.pendingAction);
    expect(JSON.stringify(modelVisible)).not.toMatch(/ownerId|proposal|payloadDigest|task_1|createdAt/);

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

  it.each([
    ["task→task", "task", "task"],
    ["task→idea-to-task", "task", "idea"],
    ["idea-to-task→task", "idea", "task"],
  ] as const)("reserves one durable proposal slot for %s", async (_label, firstKind, secondKind) => {
    let saveCount = 0;
    let firstConfirmationId: string | undefined;
    let secondReceipt: unknown;
    const { service, confirmations, tasks, ideas, world } = setup(async (_input, context) => {
      const propose = async (kind: "task" | "idea", suffix: string) => kind === "task"
        ? context.tasks.propose({ kind: "create", title: `Task ${suffix}`, project: "ASSISTANT", type: "operations" })
        : context.tasks.proposeIdeaToTask("idea-owner");
      const first = await propose(firstKind, "first");
      firstConfirmationId = "confirmationId" in first ? first.confirmationId : first.status === "needs_confirmation" ? first.confirmation.confirmationId : undefined;
      secondReceipt = await propose(secondKind, "second");
      return "unreachable";
    }, {
      wrapConfirmationStore: (store) => ({
        ...store,
        async save(record) {
          saveCount += 1;
          await store.save(record);
        },
      }),
    });
    await ideas.add({ id: "idea-owner", userId: "owner", project: "ASSISTANT", type: "development", summary: "Convert me", status: "raw" });

    await expect(service.chat({ userId: "owner", threadId: "thread", text: "two proposals" })).rejects.toThrow("only one task proposal is allowed per assistant turn");
    expect(firstConfirmationId).toBe("tool-confirmation-1");
    expect(secondReceipt).toBeUndefined();
    expect(saveCount).toBe(1);
    expect(world.auditEvents.filter(({ type }) => type === "task_mutation_proposed")).toHaveLength(1);
    await expect(confirmations.confirm("owner", "tool-confirmation-2")).resolves.toEqual({ status: "not_found" });
    await expect(confirmations.confirm("owner", firstConfirmationId!)).resolves.toMatchObject({ status: "confirmed" });
    await expect(tasks.list("owner")).resolves.toHaveLength(1);
  });

  it.each(["not_found", "already_converted"] as const)("does not reserve the proposal slot for idea-to-task %s", async (preflightStatus) => {
    let saveCount = 0;
    let preflightResult: unknown;
    const { service, tasks, ideas, world } = setup(async (_input, context) => {
      preflightResult = await context.tasks.proposeIdeaToTask(preflightStatus === "not_found" ? "missing" : "idea-owner");
      await context.tasks.propose({ kind: "create", title: "Allowed after preflight", project: "ASSISTANT", type: "operations" });
      return "ok";
    }, {
      wrapConfirmationStore: (store) => ({
        ...store,
        async save(record) {
          saveCount += 1;
          await store.save(record);
        },
      }),
    });
    if (preflightStatus === "already_converted") {
      await ideas.add({ id: "idea-owner", userId: "owner", project: "ASSISTANT", type: "development", summary: "Converted", status: "raw" });
      await tasks.create("owner", { id: "existing-task", title: "Converted", project: "ASSISTANT", type: "development", status: "open", originIdeaId: "idea-owner" });
    }

    await expect(service.chat({ userId: "owner", threadId: "thread", text: "preflight then proposal" })).resolves.toMatchObject({
      response: "ok",
      pendingAction: { confirmationId: "tool-confirmation-1" },
    });
    expect(preflightResult).toMatchObject({ status: preflightStatus });
    expect(saveCount).toBe(1);
    expect(world.auditEvents.filter(({ type }) => type === "task_mutation_proposed")).toHaveLength(1);
  });

  it("keeps the slot reserved when a save may have committed before failing", async () => {
    let saveCount = 0;
    let firstError: unknown;
    const { service, confirmations, tasks, world } = setup(async (_input, context) => {
      try {
        await context.tasks.propose({ kind: "create", title: "Uncertain", project: "ASSISTANT", type: "operations" });
      } catch (error) {
        firstError = error;
      }
      await context.tasks.propose({ kind: "create", title: "Must not persist", project: "ASSISTANT", type: "operations" });
      return "unreachable";
    }, {
      exposeIdeaStore: false,
      wrapConfirmationStore: (store) => ({
        ...store,
        async save(record) {
          saveCount += 1;
          await store.save(record);
          throw new Error("save outcome unknown");
        },
      }),
    });

    await expect(service.chat({ userId: "owner", threadId: "thread", text: "retry after uncertain save" })).rejects.toThrow("only one task proposal is allowed per assistant turn");
    expect(firstError).toEqual(new Error("save outcome unknown"));
    expect(saveCount).toBe(1);
    expect(world.auditEvents.filter(({ type }) => type === "task_mutation_proposed")).toHaveLength(0);
    await expect(confirmations.confirm("owner", "tool-confirmation-2")).resolves.toEqual({ status: "not_found" });
    await expect(confirmations.confirm("owner", "tool-confirmation-1")).resolves.toMatchObject({ status: "confirmed" });
    await expect(tasks.list("owner")).resolves.toMatchObject([{ title: "Uncertain" }]);
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
    const parsed = JSON.parse(result.response) as { ids: string[]; conversion: { status: string; confirmation: unknown } };
    expect(parsed.ids).toEqual(["task-owner"]);
    expect(parsed.conversion).toMatchObject({
      status: "needs_confirmation",
      confirmation: { actionKind: "idea_to_task", summary: "Создать задачу из идеи: Convert me" },
    });
    expect(parsed.conversion).not.toHaveProperty("taskId");
    expect(parsed.conversion).not.toHaveProperty("originIdeaId");
    expect(JSON.stringify(parsed.conversion)).not.toMatch(/ownerId|proposal|payloadDigest|task_idea_|createdAt/);
    expect(result.pendingAction).toEqual(parsed.conversion.confirmation);
    await expect(tasks.getByOriginIdeaId("owner", "idea-owner")).resolves.toBeNull();
  });
});
