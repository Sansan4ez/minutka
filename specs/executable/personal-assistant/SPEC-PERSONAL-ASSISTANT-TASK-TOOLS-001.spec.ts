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

const now = "2026-07-28T12:00:00.000Z";

function setup(runner: ConstructorParameters<typeof AssistantService>[0], options: { wrapConfirm?: (confirm: TaskMutationConfirmationService["confirm"]) => TaskMutationConfirmationService["confirm"] } = {}) {
  const clock = { now: () => now };
  const world = createInMemoryWorld(clock.now);
  const documents = createInMemoryDocumentStore(clock);
  const ideas = createInMemoryIdeaStore(clock);
  const tasks = createInMemoryTaskStore(clock);
  const ingestion = createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock), ideaStore: ideas });
  const confirmationService = new TaskMutationConfirmationService(
    createInMemoryTaskMutationConfirmationStore(tasks), clock,
    { confirmationId: (() => { let id = 0; return () => `tool-confirmation-${++id}`; })() },
  );
  const baseConfirm = confirmationService.confirm.bind(confirmationService);
  const mutations = options.wrapConfirm === undefined
    ? confirmationService
    : { propose: confirmationService.propose.bind(confirmationService), confirm: options.wrapConfirm(baseConfirm) };
  const service = new AssistantService(runner, {
    documentStore: documents,
    conversationStore: createInMemoryConversationStore(world),
    ingestionService: ingestion,
    ideaStore: ideas,
    taskStore: tasks,
    taskMutations: mutations,
    ideaToTask: new IdeaToTaskService(ideas, tasks, confirmationService),
    requestIntegrityGuard: async () => ({ status: "allowed" }),
    clock,
    idGenerator: createDeterministicIdGenerator(),
  });
  return { service, tasks, ideas };
}

describe("SPEC-PERSONAL-ASSISTANT-TASK-TOOLS-001: owner-bound confirmed task tools", () => {
  it("returns a proposal without mutation and executes it only after exact confirmation", async () => {
    let pending: Awaited<ReturnType<Parameters<ConstructorParameters<typeof AssistantService>[0]>[1]["tasks"]["propose"]>> | undefined;
    const { service, tasks } = setup(async (_input, context) => {
      pending ??= await context.tasks.propose({ kind: "create", title: "Prepare launch", project: "ASSISTANT", type: "operations", dueDate: "2026-07-30" });
      if (_input.text === "confirm") {
        const result = await context.tasks.confirm(pending.confirmationId, pending.proposal);
        return result.status;
      }
      return pending.confirmationId;
    });

    await expect(service.chat({ userId: "owner", threadId: "telegram:owner", text: "create task" })).resolves.toMatchObject({ response: "tool-confirmation-1" });
    await expect(tasks.list("owner")).resolves.toEqual([]);
    expect(pending).toMatchObject({ ownerId: "owner", proposal: { kind: "create", input: { id: "task_1", status: "open" } } });
    expect(JSON.stringify(pending)).not.toContain("telegram:owner");

    await expect(service.chat({ userId: "owner", threadId: "http:owner", text: "confirm" })).resolves.toMatchObject({ response: "confirmed" });
    await expect(tasks.list("owner")).resolves.toMatchObject([{ id: "task_1", title: "Prepare launch", userId: "owner", status: "open" }]);
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
    const parsed = JSON.parse(result.response) as { ids: string[]; conversion: { status: string; confirmation?: { ownerId: string; proposal: { kind: string; input?: { originIdeaId?: string } } } } };
    expect(parsed.ids).toEqual(["task-owner"]);
    expect(parsed.conversion).toMatchObject({ status: "needs_confirmation", confirmation: { ownerId: "owner", proposal: { kind: "create", input: { originIdeaId: "idea-owner" } } } });
    await expect(tasks.getByOriginIdeaId("owner", "idea-owner")).resolves.toBeNull();
  });

  it("does not retry or repeat a durable confirmation after provider overflow", async () => {
    let calls = 0;
    let pending: Awaited<ReturnType<Parameters<ConstructorParameters<typeof AssistantService>[0]>[1]["tasks"]["propose"]>> | undefined;
    const { service, tasks } = setup(async (_input, context) => {
      calls += 1;
      pending ??= await context.tasks.propose({ kind: "create", title: "Exactly once", project: "ASSISTANT", type: "operations" });
      await context.tasks.confirm(pending.confirmationId, pending.proposal);
      throw new Error("maximum context length exceeded");
    });

    await expect(service.chat({ userId: "owner", threadId: "thread", text: "confirmed" })).rejects.toMatchObject({
      code: "context_overflow", durableEffectCommitted: true,
    });
    expect(calls).toBe(1);
    await expect(tasks.list("owner")).resolves.toMatchObject([{ id: "task_1", title: "Exactly once" }]);
  });

  it("does not retry when a confirmation result is uncertain", async () => {
    let calls = 0;
    let confirmCalls = 0;
    let pending: Awaited<ReturnType<Parameters<ConstructorParameters<typeof AssistantService>[0]>[1]["tasks"]["propose"]>> | undefined;
    const runner: ConstructorParameters<typeof AssistantService>[0] = async (_input, context) => {
      calls += 1;
      pending ??= await context.tasks.propose({ kind: "create", title: "Uncertain", project: "ASSISTANT", type: "operations" });
      try { await context.tasks.confirm(pending.confirmationId, pending.proposal); }
      catch { throw new Error("maximum context length exceeded"); }
      return "unreachable";
    };
    const { service, tasks } = setup(runner, {
      wrapConfirm: (baseConfirm) => async (...args) => {
        confirmCalls += 1;
        await baseConfirm(...args);
        throw new Error("connection lost after commit");
      },
    });

    await expect(service.chat({ userId: "owner", threadId: "thread", text: "confirm uncertain" })).rejects.toMatchObject({ code: "mutation_outcome_unknown" });
    expect(calls).toBe(1);
    expect(confirmCalls).toBe(1);
    await expect(tasks.list("owner")).resolves.toMatchObject([{ id: "task_1", title: "Uncertain" }]);
    await expect(service.chat({ userId: "owner", threadId: "thread", text: "reconcile" })).rejects.toMatchObject({ code: "mutation_outcome_unknown" });
    expect(confirmCalls).toBe(2);
    await expect(tasks.list("owner")).resolves.toHaveLength(1);
  });
});
