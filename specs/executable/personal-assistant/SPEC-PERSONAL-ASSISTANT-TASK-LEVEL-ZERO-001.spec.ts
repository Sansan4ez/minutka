import { describe, expect, it } from "vitest";
import { AssistantService, missingAgentResponseUserMessage } from "../../../src/application/assistant-service.js";
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
import { createTaskTools } from "../../../src/mastra/tools/task-tools.js";

function setup(
  runner: ConstructorParameters<typeof AssistantService>[0],
  options: { wrapConfirmationStore?: (store: TaskMutationConfirmationStore) => TaskMutationConfirmationStore } = {},
) {
  let now = "2026-08-04T09:00:00.000Z";
  const clock = { now: () => now };
  const world = createInMemoryWorld(clock.now);
  const documents = createInMemoryDocumentStore(clock);
  const ideas = createInMemoryIdeaStore(clock);
  const tasks = createInMemoryTaskStore(clock);
  const ingestion = createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock), ideaStore: ideas });
  const baseConfirmationStore = createInMemoryTaskMutationConfirmationStore(tasks, ideas);
  const confirmations = new TaskMutationConfirmationService(options.wrapConfirmationStore?.(baseConfirmationStore) ?? baseConfirmationStore, clock, {
    confirmationId: (() => { let id = 0; return () => `level-zero-${++id}`; })(),
  });
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
  return { service, tasks, ideas, confirmations, advance(milliseconds: number) { now = new Date(Date.parse(now) + milliseconds).toISOString(); } };
}

describe("SPEC-PERSONAL-ASSISTANT-TASK-LEVEL-ZERO-001", () => {
  it("applies create without a pending action and exhausts the general undo stack", async () => {
    let applied: unknown;
    const env = setup(async (_input, context) => {
      applied = await context.tasks.propose({ kind: "create", title: "Купить корм", project: "дом", type: "personal", dueDate: "2026-08-07" });
      return "Записал: купить корм, проект «дом», срок — пятница. Скажи «отмени», если не то.";
    });

    const result = await env.service.chat({ userId: "owner", threadId: "telegram:owner", text: "заведи задачу купить корм на пятницу" });
    expect(result).toMatchObject({ effect: "business_write_committed", response: expect.stringContaining("отмени") });
    expect(result.pendingActions[0]).toBeUndefined();
    expect(JSON.stringify(result)).not.toMatch(/level-zero-|task_1/);
    expect(applied).toMatchObject({ status: "applied", actionKind: "create", undoAvailable: true, task: { title: "Купить корм" } });
    expect(JSON.stringify(applied)).not.toMatch(/confirmationId|payloadDigest|ownerId|proposal/);
    await expect(env.tasks.list("owner")).resolves.toHaveLength(1);

    await expect(env.confirmations.undo("owner")).resolves.toMatchObject({ status: "undone", actionKind: "create", task: { title: "Купить корм" } });
    await expect(env.tasks.list("owner")).resolves.toEqual([]);
    await expect(env.confirmations.undo("owner")).resolves.toEqual({ status: "not_found" });
  });

  it("reports an honest summary instead of failing when the agent stops after a committed write", async () => {
    const env = setup(async (_input, context) => {
      await context.tasks.propose({ kind: "create", title: "Купить корм", project: "дом", type: "personal" });
      return "";
    });

    const result = await env.service.chat({ userId: "owner", threadId: "telegram:owner", text: "заведи задачу купить корм" });
    expect(result).toMatchObject({ effect: "business_write_committed", response: missingAgentResponseUserMessage });
    await expect(env.tasks.list("owner")).resolves.toHaveLength(1);
  });

  it("walks backward through sequential reversible mutations", async () => {
    const env = setup(async () => "unused");
    await env.tasks.create("owner", { id: "task-stack", title: "Исходная", project: "дом", type: "personal", status: "open" });
    const first = await env.confirmations.propose("owner", {
      kind: "update", taskId: "task-stack", expectedRevision: 1, patch: { project: "работа" },
    }, { actionKind: "update" });
    await env.confirmations.autoApply("owner", first.confirmationId);
    env.advance(1);
    const second = await env.confirmations.propose("owner", {
      kind: "update", taskId: "task-stack", expectedRevision: 2, patch: { status: "done" },
    }, { actionKind: "complete" });
    await env.confirmations.autoApply("owner", second.confirmationId);

    await expect(env.confirmations.undo("owner")).resolves.toMatchObject({ status: "undone", actionKind: "complete" });
    await expect(env.tasks.get("owner", "task-stack")).resolves.toMatchObject({ project: "работа", status: "open", revision: 4 });
    await expect(env.confirmations.undo("owner")).resolves.toMatchObject({ status: "conflict", actionKind: "update", current: { revision: 4 } });
    await expect(env.tasks.get("owner", "task-stack")).resolves.toMatchObject({ project: "работа", status: "open", revision: 4 });
  });

  it("undoes two independent mutations from newest to oldest and then returns not_found", async () => {
    const env = setup(async () => "unused");
    const first = await env.confirmations.propose("owner", {
      kind: "create", input: { id: "task-first", title: "Первая", project: "дом", type: "personal", status: "open" },
    });
    await env.confirmations.autoApply("owner", first.confirmationId);
    env.advance(1);
    const second = await env.confirmations.propose("owner", {
      kind: "create", input: { id: "task-second", title: "Вторая", project: "дом", type: "personal", status: "open" },
    });
    await env.confirmations.autoApply("owner", second.confirmationId);

    await expect(env.confirmations.undo("owner")).resolves.toMatchObject({ status: "undone", task: { id: "task-second" } });
    await expect(env.confirmations.undo("owner")).resolves.toMatchObject({ status: "undone", task: { id: "task-first" } });
    await expect(env.confirmations.undo("owner")).resolves.toEqual({ status: "not_found" });
  });

  it("restores previous update and completion state from the canonical record", async () => {
    const env = setup(async (_input, context) => {
      const [task] = await context.tasks.list();
      await context.tasks.propose({ kind: "update", taskId: task!.id, patch: { dueDate: "2026-08-10", project: "новый" } });
      return "Перенёс срок и проект. Скажи «отмени», если не то.";
    });
    await env.tasks.create("owner", { id: "task-existing", title: "Позвонить", project: "старый", type: "operations", status: "open", dueDate: "2026-08-05" });

    await expect(env.service.chat({ userId: "owner", threadId: "thread", text: "перенеси срок" })).resolves.toMatchObject({ effect: "business_write_committed" });
    await expect(env.tasks.get("owner", "task-existing")).resolves.toMatchObject({ project: "новый", dueDate: "2026-08-10", revision: 2 });
    await expect(env.confirmations.undo("owner")).resolves.toMatchObject({ status: "undone", actionKind: "update" });
    await expect(env.tasks.get("owner", "task-existing")).resolves.toMatchObject({ project: "старый", dueDate: "2026-08-05", status: "open", revision: 3 });

    const completeEnv = setup(async (_input, context) => {
      const [task] = await context.tasks.list();
      await context.tasks.propose({ kind: "complete", taskId: task!.id });
      return "Отметил сделанной. Скажи «отмени», если не то.";
    });
    await completeEnv.tasks.create("owner", { id: "task-complete", title: "Сделать", project: "дом", type: "personal", status: "in_progress" });
    await completeEnv.service.chat({ userId: "owner", threadId: "thread", text: "отметь сделанной" });
    await expect(completeEnv.tasks.get("owner", "task-complete")).resolves.toMatchObject({ status: "done" });
    await expect(completeEnv.confirmations.undo("owner")).resolves.toMatchObject({ status: "undone", actionKind: "complete" });
    await expect(completeEnv.tasks.get("owner", "task-complete")).resolves.toMatchObject({ status: "in_progress" });
  });

  it("returns a terminal conflict without a pending card when a level-zero update becomes stale", async () => {
    let modelVisible: unknown;
    let tasksForSaveHook!: ReturnType<typeof createInMemoryTaskStore>;
    const env = setup(async (_input, context) => {
      modelVisible = await context.tasks.propose({ kind: "update", taskId: "task-stale", expectedRevision: 1, patch: { project: "новый" } });
      return "Задача уже изменилась, поэтому ничего не менял. Могу перечитать её и повторить с актуальными данными.";
    }, {
      wrapConfirmationStore: (store) => ({
        ...store,
        async save(record) {
          await store.save(record);
          await tasksForSaveHook.update("owner", "task-stale", { expectedRevision: 1, patch: { status: "in_progress" } });
        },
      }),
    });
    tasksForSaveHook = env.tasks;
    await env.tasks.create("owner", { id: "task-stale", title: "Позвонить", project: "старый", type: "operations", status: "open" });

    const result = await env.service.chat({ userId: "owner", threadId: "thread", text: "перенеси задачу" });

    expect(result).toMatchObject({ effect: "none", pendingActions: [], response: expect.stringMatching(/ничего не менял/i) });
    expect(modelVisible).toMatchObject({ status: "conflict", actionKind: "update", current: { project: "старый", status: "in_progress", revision: 2 } });
    expect(JSON.stringify(modelVisible)).not.toMatch(/confirmationId|payloadDigest|ownerId|proposal|undoAvailable/);
    await expect(env.tasks.get("owner", "task-stale")).resolves.toMatchObject({ project: "старый", status: "in_progress", revision: 2 });
    await expect(env.confirmations.confirm("owner", "level-zero-1")).resolves.toMatchObject({
      status: "already_confirmed", outcome: { outcome: "conflict", current: { revision: 2 } },
    });
    await expect(env.tasks.get("owner", "task-stale")).resolves.toMatchObject({ project: "старый", status: "in_progress", revision: 2 });
  });

  it("returns terminal not_found for a missing completion without a saved-proposal message", async () => {
    let modelVisible: unknown;
    let tasksForSaveHook!: ReturnType<typeof createInMemoryTaskStore>;
    const env = setup(async (_input, context) => {
      modelVisible = await context.tasks.propose({ kind: "complete", taskId: "task-missing", expectedRevision: 1 });
      return "Задача больше не найдена, поэтому ничего не менял. Могу перечитать список задач.";
    }, {
      wrapConfirmationStore: (store) => ({
        ...store,
        async save(record) {
          await store.save(record);
          await tasksForSaveHook.delete("owner", "task-missing", { expectedRevision: 1 });
        },
      }),
    });
    tasksForSaveHook = env.tasks;
    await env.tasks.create("owner", { id: "task-missing", title: "Исчезающая", project: "дом", type: "personal", status: "open" });

    const result = await env.service.chat({ userId: "owner", threadId: "thread", text: "заверши исчезающую задачу" });

    expect(result).toMatchObject({ effect: "none", pendingActions: [], response: expect.stringMatching(/ничего не менял/i) });
    expect(result.response).not.toMatch(/предложени.+сохран|подтвержден/i);
    expect(modelVisible).toEqual({ status: "not_found", actionKind: "complete" });
    expect(JSON.stringify(modelVisible)).not.toMatch(/confirmationId|payloadDigest|ownerId|proposal|undoAvailable/);
    await expect(env.tasks.get("owner", "task-missing")).resolves.toBeNull();
    await expect(env.confirmations.confirm("owner", "level-zero-1")).resolves.toEqual({
      status: "already_confirmed", outcome: { outcome: "not_found" },
    });
  });

  it("accepts safe terminal no-effect results in task tool output schemas", () => {
    const tools = createTaskTools({
      async list() { return []; },
      async propose() { return { status: "not_found", actionKind: "complete" }; },
      async proposeIdeaToTask() { return { status: "conflict", actionKind: "idea_to_task" }; },
      async undoLast() { return { status: "not_found" }; },
    });
    const proposalSchema = tools.proposeTaskMutation.outputSchema as unknown as { parse(value: unknown): unknown };
    const ideaSchema = tools.proposeIdeaToTask.outputSchema as unknown as { parse(value: unknown): unknown };
    const undoSchema = tools.undoTaskMutation.outputSchema as unknown as { parse(value: unknown): unknown };

    expect(proposalSchema.parse({ status: "conflict", actionKind: "update", current: {
      id: "task-safe", title: "Безопасно", project: "дом", type: "personal", status: "open",
      createdAt: "2026-08-04T09:00:00.000Z", updatedAt: "2026-08-04T09:00:00.000Z", revision: 2,
    } })).toMatchObject({ status: "conflict", actionKind: "update" });
    expect(ideaSchema.parse({ status: "not_found", actionKind: "idea_to_task" })).toEqual({ status: "not_found", actionKind: "idea_to_task" });
    expect(undoSchema.parse({
      status: "undone", actionKind: "idea_to_task", ideaStatusRestored: false, ideaStatusConflict: true,
      task: {
        id: "task-safe", title: "Безопасно", project: "дом", type: "personal", status: "open",
        createdAt: "2026-08-04T09:00:00.000Z", updatedAt: "2026-08-04T09:00:00.000Z", revision: 1,
      },
    })).toMatchObject({ status: "undone", ideaStatusConflict: true });
    expect(() => proposalSchema.parse({ status: "conflict", actionKind: "update", confirmationId: "private" })).toThrow();
    expect(() => ideaSchema.parse({ status: "not_found", actionKind: "idea_to_task", proposal: {} })).toThrow();
    expect(() => undoSchema.parse({ status: "undone", actionKind: "idea_to_task", task: {}, ideaExpectedRevision: 2 })).toThrow();
  });

  it("undoes idea-to-task by deleting the task and restoring the previous idea status", async () => {
    const env = setup(async (_input, context) => {
      const conversion = await context.tasks.proposeIdeaToTask("idea-1");
      expect(conversion).toMatchObject({ status: "applied", actionKind: "idea_to_task" });
      return "Создал задачу из идеи. Скажи «отмени», если не то.";
    });
    await env.ideas.add({ id: "idea-1", userId: "owner", project: "дом", type: "personal", summary: "Купить корм", status: "raw" });

    await env.service.chat({ userId: "owner", threadId: "thread", text: "сделай задачу из идеи" });
    await expect(env.ideas.get("owner", "idea-1")).resolves.toMatchObject({ status: "planned" });
    await expect(env.tasks.getByOriginIdeaId("owner", "idea-1")).resolves.toMatchObject({ title: "Купить корм" });
    await expect(env.confirmations.undo("owner")).resolves.toMatchObject({ status: "undone", actionKind: "idea_to_task", ideaStatusRestored: true });
    await expect(env.tasks.getByOriginIdeaId("owner", "idea-1")).resolves.toBeNull();
    await expect(env.ideas.get("owner", "idea-1")).resolves.toMatchObject({ status: "raw" });
  });

  it("deletes the converted task but preserves a concurrently changed idea status", async () => {
    const env = setup(async () => "unused");
    await env.ideas.add({ id: "idea-conflict", userId: "owner", project: "дом", type: "personal", summary: "Не затирать", status: "raw" });
    const proposed = await new IdeaToTaskService(env.ideas, env.tasks, env.confirmations).propose("owner", "idea-conflict");
    if (proposed.status !== "needs_confirmation") throw new Error("expected confirmation");
    await env.confirmations.autoApply("owner", proposed.confirmation.confirmationId);
    await env.ideas.update("owner", "idea-conflict", { status: "done" });

    const undo = await env.confirmations.undo("owner");

    expect(undo).toMatchObject({
      status: "undone", actionKind: "idea_to_task", ideaStatusRestored: false, ideaStatusConflict: true,
    });
    expect(JSON.stringify(undo)).not.toMatch(/ideaBeforeStatus|ideaExpectedStatus|ideaExpectedRevision|undoContext/);
    await expect(env.tasks.getByOriginIdeaId("owner", "idea-conflict")).resolves.toBeNull();
    await expect(env.ideas.get("owner", "idea-conflict")).resolves.toMatchObject({ status: "done", revision: 3 });
  });

  it("keeps cancellation pending and returns a clear expired undo outcome without skipping to an older mutation", async () => {
    const env = setup(async (_input, context) => {
      const [task] = await context.tasks.list();
      return JSON.stringify(await context.tasks.propose({ kind: "cancel", taskId: task!.id }));
    });
    await env.tasks.create("owner", { id: "task-cancel", title: "Не удалять сразу", project: "дом", type: "personal", status: "open" });
    const pending = await env.service.chat({ userId: "owner", threadId: "thread", text: "отмени задачу" });
    expect(pending).toMatchObject({ effect: "pending_action_created", pendingActions: [{ actionKind: "cancel" }] });
    await expect(env.tasks.get("owner", "task-cancel")).resolves.toMatchObject({ status: "open" });

    const createEnv = setup(async (_input, context) => {
      await context.tasks.propose({ kind: "create", title: "Короткое окно", project: "дом", type: "personal" });
      return "Записал. Скажи «отмени», если не то.";
    });
    await createEnv.service.chat({ userId: "owner", threadId: "thread", text: "создай" });
    createEnv.advance(1);
    const latest = await createEnv.confirmations.propose("owner", {
      kind: "create", input: { id: "task-latest-expired", title: "Просроченная", project: "дом", type: "personal", status: "open" },
    });
    await createEnv.confirmations.autoApply("owner", latest.confirmationId);
    createEnv.advance(15 * 60_000 + 1);
    await expect(createEnv.confirmations.undo("owner")).resolves.toEqual({ status: "expired" });
    await expect(createEnv.tasks.list("owner")).resolves.toHaveLength(2);
  });
});
