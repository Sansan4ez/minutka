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

function setup(runner: ConstructorParameters<typeof AssistantService>[0]) {
  let now = "2026-08-04T09:00:00.000Z";
  const clock = { now: () => now };
  const world = createInMemoryWorld(clock.now);
  const documents = createInMemoryDocumentStore(clock);
  const ideas = createInMemoryIdeaStore(clock);
  const tasks = createInMemoryTaskStore(clock);
  const ingestion = createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock), ideaStore: ideas });
  const confirmations = new TaskMutationConfirmationService(createInMemoryTaskMutationConfirmationStore(tasks, ideas), clock, {
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
  it("applies create without a pending action and undoes it idempotently", async () => {
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
    await expect(env.confirmations.undo("owner")).resolves.toMatchObject({ status: "already_undone" });
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

  it("keeps cancellation pending and returns a clear expired undo outcome", async () => {
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
    createEnv.advance(15 * 60_000 + 1);
    await expect(createEnv.confirmations.undo("owner")).resolves.toEqual({ status: "expired" });
    await expect(createEnv.tasks.list("owner")).resolves.toHaveLength(1);
  });
});
