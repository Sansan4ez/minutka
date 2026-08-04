import { describe, expect, it, vi } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import type { ConversationStore } from "../../../src/application/conversation-store.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";
import { createInMemoryTaskMutationConfirmationStore } from "../../../src/application/in-memory-task-mutation-confirmation-store.js";
import { createInMemoryTaskStore } from "../../../src/application/in-memory-task-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService, type IngestionService } from "../../../src/application/ingestion-service.js";
import { IdeaToTaskService } from "../../../src/application/idea-to-task.js";
import { createDeterministicIdGenerator } from "../../../src/application/runtime-primitives.js";
import { TaskMutationConfirmationService, type TaskMutationConfirmationStore } from "../../../src/application/task-mutation-confirmation.js";
import { overflowAfterDurableWriteAndPendingActionUserMessage, overflowAfterPendingActionUserMessage } from "../../../src/application/assistant-overflow-recovery.js";
import { mutationOutcomeUnknownWithPendingActionUserMessage } from "../../../src/application/assistant-mutation-outcome.js";
import { createAssistantAgentRunner, type MastraAgentLike } from "../../../src/mastra/agent-runner.js";

const now = "2026-07-28T12:00:00.000Z";

function setup(
  runner: ConstructorParameters<typeof AssistantService>[0],
  options: {
    wrapConfirmationStore?: (store: TaskMutationConfirmationStore) => TaskMutationConfirmationStore;
    wrapCaptureIdea?: (captureIdea: IngestionService["captureIdea"]) => IngestionService["captureIdea"];
    wrapConversationStore?: (store: ConversationStore) => ConversationStore;
    exposeIdeaStore?: boolean;
    applicationTimeoutMs?: number;
  } = {},
) {
  const clock = { now: () => now };
  const world = createInMemoryWorld(clock.now);
  const documents = createInMemoryDocumentStore(clock);
  const ideas = createInMemoryIdeaStore(clock);
  const tasks = createInMemoryTaskStore(clock);
  const ingestion = createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock), ideaStore: ideas });
  const baseConfirmationStore = createInMemoryTaskMutationConfirmationStore(tasks, ideas);
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
  const baseConversationStore = createInMemoryConversationStore(world);
  const service = new AssistantService(runner, {
    documentStore: documents,
    conversationStore: options.wrapConversationStore?.(baseConversationStore) ?? baseConversationStore,
    ingestionService: options.wrapCaptureIdea === undefined
      ? ingestion
      : { ...ingestion, captureIdea: options.wrapCaptureIdea(ingestion.captureIdea) },
    ...(options.exposeIdeaStore === false ? {} : { ideaStore: ideas }),
    taskStore: tasks,
    taskMutations: { propose: confirmations.propose.bind(confirmations) },
    ideaToTask: new IdeaToTaskService(ideas, tasks, confirmations),
    auditEventStore,
    requestIntegrityGuard: async () => ({ status: "allowed" }),
    clock,
    idGenerator: createDeterministicIdGenerator(),
    ...(options.applicationTimeoutMs === undefined ? {} : { applicationTimeoutMs: options.applicationTimeoutMs }),
  });
  return { service, confirmations, tasks, ideas, world };
}

describe("SPEC-PERSONAL-ASSISTANT-TASK-TOOLS-001: owner-bound task proposals", () => {
  it("resolves an omitted task revision into the pending proposal and still detects a later conflict", async () => {
    const { service, confirmations, tasks } = setup(async (_input, context) => {
      const [task] = await context.tasks.list();
      expect(task).toMatchObject({ id: "existing-task", revision: 1 });
      await context.tasks.propose({ kind: "complete", taskId: task!.id });
      return "Предложение готово";
    });
    await tasks.create("owner", {
      id: "existing-task", title: "Записаться в бассейн", project: "здоровье", type: "personal", status: "open",
    });

    const result = await service.chat({ userId: "owner", threadId: "telegram:owner", text: "complete task" });
    expect(result.pendingActions[0]).toMatchObject({ actionKind: "complete", preview: { kind: "complete", taskTitle: { value: "Записаться в бассейн", truncated: false } } });

    await tasks.update("owner", "existing-task", { expectedRevision: 1, patch: { status: "in_progress" } });
    await expect(confirmations.confirm("owner", result.pendingActions[0]!.confirmationId)).resolves.toMatchObject({
      status: "confirmed",
      outcome: { outcome: "conflict", current: { revision: 2, status: "in_progress" } },
    });
    await expect(tasks.get("owner", "existing-task")).resolves.toMatchObject({ status: "in_progress", revision: 2 });
  });

  it("returns one safe typed pending action without mutating a task", async () => {
    let modelVisible: unknown;
    const { service, confirmations, tasks } = setup(async (_input, context) => {
      modelVisible = await context.tasks.propose({ kind: "create", title: "Prepare launch", project: "ASSISTANT", type: "operations", dueDate: "2026-07-30" });
      return "Предложение готово";
    });

    const result = await service.chat({ userId: "owner", threadId: "telegram:owner", text: "create task" });
    expect(result).toMatchObject({
      response: "Предложение готово",
      pendingActions: [{
        confirmationId: "tool-confirmation-1",
        actionKind: "create",
        summary: "Создать задачу: Prepare launch",
        expiresAt: expect.any(String),
        preview: {
          kind: "create",
          title: { value: "Prepare launch", truncated: false },
          project: { value: "ASSISTANT", truncated: false },
          type: "operations",
          dueDate: "2026-07-30",
        },
      }],
    });
    expect(result.pendingActions[0]).not.toHaveProperty("ownerId");
    expect(result.pendingActions[0]).not.toHaveProperty("proposal");
    expect(result.pendingActions[0]).not.toHaveProperty("payloadDigest");
    await expect(tasks.list("owner")).resolves.toEqual([]);
    expect(modelVisible).not.toHaveProperty("preview");
    expect(modelVisible).toMatchObject({ confirmationId: result.pendingActions[0]!.confirmationId, actionKind: "create", summary: "Создать задачу: Prepare launch" });
    expect(JSON.stringify(modelVisible)).not.toMatch(/ownerId|proposal|payloadDigest|task_1|createdAt|preview|dueDate/);

    await expect(confirmations.confirm("owner", result.pendingActions[0]!.confirmationId)).resolves.toMatchObject({ status: "confirmed" });
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
      pendingActions: [{ confirmationId: "tool-confirmation-1", summary: "Создать задачу: Overflow proposal" }],
      effect: "pending_action_created",
    });
    expect(calls).toBe(1);
    await expect(tasks.list("owner")).resolves.toEqual([]);
  });

  it.each([
    ["capture→proposal", "capture-first"],
    ["proposal→capture", "proposal-first"],
  ] as const)("preserves committed write and pending action for %s overflow", async (_label, order) => {
    let calls = 0;
    const { service, tasks, ideas } = setup(async (_input, context) => {
      calls += 1;
      const capture = () => context.captureIdea({
        project: "ASSISTANT",
        type: "development",
        summary: `Compound ${order}`,
        suggestedNextStep: "Review both effects.",
        needsProjectClarification: false,
      });
      const propose = () => context.tasks.propose({ kind: "create", title: `Proposal ${order}`, project: "ASSISTANT", type: "operations" });
      if (order === "capture-first") {
        await capture();
        await propose();
      } else {
        await propose();
        await capture();
      }
      throw new Error("maximum context length exceeded");
    });

    const result = await service.chat({ userId: "owner", threadId: "thread", text: "capture and propose" });

    expect(result).toMatchObject({
      response: overflowAfterDurableWriteAndPendingActionUserMessage,
      effect: "business_write_committed",
      pendingActions: [{ confirmationId: "tool-confirmation-1", summary: `Создать задачу: Proposal ${order}` }],
    });
    expect(calls).toBe(1);
    await expect(ideas.list("owner")).resolves.toMatchObject([{ summary: `Compound ${order}` }]);
    await expect(tasks.list("owner")).resolves.toEqual([]);
    expect(JSON.stringify(result)).not.toMatch(/ownerId|payloadDigest|createdAt|\"proposal\"/);
  });

  it("preserves an uncertain write together with a confirmable pending action", async () => {
    let calls = 0;
    const { service, confirmations, tasks, ideas } = setup(async (_input, context) => {
      calls += 1;
      await context.tasks.propose({ kind: "create", title: "Proposal before uncertainty", project: "ASSISTANT", type: "operations" });
      try {
        await context.captureIdea({
          project: "ASSISTANT",
          type: "development",
          summary: "Committed before result was lost",
          suggestedNextStep: "Reconcile before retrying.",
          needsProjectClarification: false,
        });
      } catch {
        throw new Error("maximum context length exceeded");
      }
      return "unreachable";
    }, {
      wrapCaptureIdea: (captureIdea) => async (input) => {
        await captureIdea(input);
        throw new Error("connection lost after commit");
      },
    });

    const result = await service.chat({ userId: "owner", threadId: "thread", text: "propose and capture uncertainly" });

    expect(result).toMatchObject({
      response: mutationOutcomeUnknownWithPendingActionUserMessage,
      effect: "outcome_unknown",
      pendingActions: [{ confirmationId: "tool-confirmation-1", summary: "Создать задачу: Proposal before uncertainty" }],
    });
    expect(calls).toBe(1);
    await expect(ideas.list("owner")).resolves.toMatchObject([{ summary: "Committed before result was lost" }]);
    await expect(tasks.list("owner")).resolves.toEqual([]);
    await expect(confirmations.confirm("owner", result.pendingActions[0]!.confirmationId)).resolves.toMatchObject({ status: "confirmed" });
    await expect(tasks.list("owner")).resolves.toMatchObject([{ title: "Proposal before uncertainty" }]);
    expect(JSON.stringify(result)).not.toMatch(/ownerId|payloadDigest|createdAt|\"proposal\"/);
  });

  it("returns up to five independently durable pending actions in one turn", async () => {
    let saveCount = 0;
    const { service, confirmations, tasks, world } = setup(async (_input, context) => {
      await context.tasks.propose({ kind: "cancel", taskId: "task-one" });
      await context.tasks.propose({ kind: "cancel", taskId: "task-two" });
      return "Два предложения.";
    }, {
      wrapConfirmationStore: (store) => ({
        ...store,
        async save(record) { saveCount += 1; await store.save(record); },
      }),
    });
    await tasks.create("owner", { id: "task-one", title: "One", project: "ASSISTANT", type: "operations", status: "open" });
    await tasks.create("owner", { id: "task-two", title: "Two", project: "ASSISTANT", type: "operations", status: "open" });

    const result = await service.chat({ userId: "owner", threadId: "thread", text: "two proposals" });

    expect(result).toMatchObject({
      response: "Два предложения.",
      effect: "pending_action_created",
      pendingActions: [
        { confirmationId: "tool-confirmation-1", actionKind: "cancel" },
        { confirmationId: "tool-confirmation-2", actionKind: "cancel" },
      ],
    });
    expect(saveCount).toBe(2);
    expect(world.auditEvents.filter(({ type }) => type === "task_mutation_proposed")).toHaveLength(2);
    await expect(confirmations.confirm("owner", result.pendingActions[0]!.confirmationId)).resolves.toMatchObject({ status: "confirmed" });
    await expect(confirmations.confirm("owner", result.pendingActions[1]!.confirmationId)).resolves.toMatchObject({ status: "confirmed" });
    await expect(tasks.get("owner", "task-one")).resolves.toMatchObject({ status: "cancelled" });
    await expect(tasks.get("owner", "task-two")).resolves.toMatchObject({ status: "cancelled" });
  });

  it("stops at the group limit and explicitly tells the owner that only part was shown", async () => {
    const { service, tasks } = setup(async (_input, context) => {
      for (let index = 1; index <= 6; index += 1) await context.tasks.propose({ kind: "cancel", taskId: `bounded-${index}` });
      return "unreachable";
    });
    for (let index = 1; index <= 6; index += 1) await tasks.create("owner", { id: `bounded-${index}`, title: `Task ${index}`, project: "ASSISTANT", type: "operations", status: "open" });

    const result = await service.chat({ userId: "owner", threadId: "thread", text: "cancel six" });

    expect(result.pendingActions).toHaveLength(5);
    expect(result.response).toContain("Показал только эту часть");
    await expect(tasks.get("owner", "bounded-6")).resolves.toMatchObject({ status: "open" });
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
      pendingActions: [{ confirmationId: "tool-confirmation-1" }],
    });
    expect(preflightResult).toMatchObject({ status: preflightStatus });
    expect(saveCount).toBe(1);
    expect(world.auditEvents.filter(({ type }) => type === "task_mutation_proposed")).toHaveLength(1);
  });

  it.each([
    ["committed before throw", true, false],
    ["not committed and the tool error is swallowed", false, true],
  ] as const)("returns an owner-visible uncertain proposal when save is %s", async (_label, commits, swallowToolError) => {
    let saveCount = 0;
    let calls = 0;
    const { service, confirmations, tasks, ideas, world } = setup(async (_input, context) => {
      calls += 1;
      try {
        await context.tasks.propose({ kind: "create", title: "Uncertain", project: "ASSISTANT", type: "operations" });
      } catch (error) {
        if (swallowToolError) return "tool error was swallowed";
        throw error;
      }
      return "unreachable";
    }, {
      wrapConfirmationStore: (store) => ({
        ...store,
        async save(record) {
          saveCount += 1;
          if (commits) await store.save(record);
          throw new Error("save outcome unknown");
        },
      }),
    });

    const result = await service.chat({ userId: "owner", threadId: "thread", text: "create uncertain task" });

    expect(result).toMatchObject({
      response: expect.stringMatching(/не удалось подтвердить, сохранено ли предложение задачи/i),
      effect: "outcome_unknown",
      pendingActions: [{ confirmationId: "tool-confirmation-1", actionKind: "create", summary: "Создать задачу: Uncertain" }],
    });
    expect(calls).toBe(1);
    expect(saveCount).toBe(1);
    expect(world.auditEvents.filter(({ type }) => type === "task_mutation_proposed")).toHaveLength(0);
    await expect(ideas.list("owner")).resolves.toEqual([]);
    await expect(confirmations.confirm("owner", result.pendingActions[0]!.confirmationId)).resolves.toMatchObject(
      commits ? { status: "confirmed" } : { status: "not_found" },
    );
    await expect(tasks.list("owner")).resolves.toHaveLength(commits ? 1 : 0);
    expect(JSON.stringify(result)).not.toMatch(/ownerId|payloadDigest|createdAt|\"proposal\"|task_1/);
  });

  it("recovers a persisted proposal when the application deadline aborts the agent loop", async () => {
    let agentCalls = 0;
    const { service, confirmations, tasks } = setup(async (_input, context, signal) => {
      agentCalls += 1;
      await context.tasks.propose({ kind: "create", title: "Deadline recovery", project: "ASSISTANT", type: "operations" });
      return await new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
    }, { applicationTimeoutMs: 10 });

    const result = await service.chat({ userId: "owner", threadId: "thread", text: "create before deadline" });

    expect(result).toMatchObject({
      effect: "pending_action_created",
      pendingActions: [{ confirmationId: "tool-confirmation-1", summary: "Создать задачу: Deadline recovery" }],
      response: expect.stringMatching(/предложение задачи сохранено/i),
    });
    expect(agentCalls).toBe(1);
    await expect(confirmations.confirm("owner", result.pendingActions[0]!.confirmationId)).resolves.toMatchObject({ status: "confirmed" });
    await expect(tasks.list("owner")).resolves.toMatchObject([{ title: "Deadline recovery" }]);
  });

  it("does not persist a proposal that starts after the application deadline", async () => {
    let saveCount = 0;
    const { service, confirmations } = setup(async (_input, context, signal) => {
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      await context.tasks.propose({ kind: "create", title: "Too late", project: "ASSISTANT", type: "operations" });
      return "unreachable";
    }, {
      applicationTimeoutMs: 10,
      wrapConfirmationStore: (store) => ({
        ...store,
        async save(record) { saveCount += 1; await store.save(record); },
      }),
    });

    await expect(service.chat({ userId: "owner", threadId: "thread", text: "abort first" })).rejects.toMatchObject({ name: "TimeoutError" });
    expect(saveCount).toBe(0);
    await expect(confirmations.confirm("owner", "tool-confirmation-1")).resolves.toEqual({ status: "not_found" });
  });

  it("keeps the slot reserved after an uncertain save without attempting a second proposal", async () => {
    let saveCount = 0;
    let secondError: unknown;
    const { service, confirmations, tasks } = setup(async (_input, context) => {
      try {
        await context.tasks.propose({ kind: "create", title: "Uncertain", project: "ASSISTANT", type: "operations" });
      } catch {
        try {
          await context.tasks.propose({ kind: "create", title: "Must not persist", project: "ASSISTANT", type: "operations" });
        } catch (error) {
          secondError = error;
        }
      }
      return "tool error was swallowed";
    }, {
      wrapConfirmationStore: (store) => ({
        ...store,
        async save(record) {
          saveCount += 1;
          await store.save(record);
          throw new Error("save outcome unknown");
        },
      }),
    });

    const result = await service.chat({ userId: "owner", threadId: "thread", text: "retry after uncertain save" });

    expect(result).toMatchObject({ effect: "outcome_unknown", pendingActions: [{ confirmationId: "tool-confirmation-1" }] });
    expect(secondError).toEqual(new Error("a task proposal with unknown persistence keeps its pending action slot reserved"));
    expect(saveCount).toBe(1);
    await expect(confirmations.confirm("owner", "tool-confirmation-2")).resolves.toEqual({ status: "not_found" });
    await expect(confirmations.confirm("owner", result.pendingActions[0]!.confirmationId)).resolves.toMatchObject({ status: "confirmed" });
    await expect(tasks.list("owner")).resolves.toMatchObject([{ title: "Uncertain" }]);
  });

  it.each([
    ["without a business write", false],
    ["with a committed business write", true],
  ] as const)("recovers a persisted proposal after a downstream non-overflow error %s", async (_label, captureFirst) => {
    let calls = 0;
    const { service, confirmations, tasks, ideas } = setup(async (_input, context) => {
      calls += 1;
      if (captureFirst) {
        await context.captureIdea({
          project: "ASSISTANT",
          type: "development",
          summary: "Committed alongside proposal",
          suggestedNextStep: "Confirm the task.",
          needsProjectClarification: false,
        });
      }
      await context.tasks.propose({ kind: "create", title: "Persisted before failure", project: "ASSISTANT", type: "operations" });
      throw new Error("provider connection closed");
    });

    const result = await service.chat({ userId: "owner", threadId: "thread", text: "create then fail" });

    expect(result).toMatchObject({
      response: expect.stringMatching(captureFirst ? /изменение уже сохранено/i : /предложение задачи сохранено/i),
      effect: captureFirst ? "business_write_committed" : "pending_action_created",
      pendingActions: [{ confirmationId: "tool-confirmation-1", summary: "Создать задачу: Persisted before failure" }],
    });
    expect(calls).toBe(1);
    await expect(ideas.list("owner")).resolves.toHaveLength(captureFirst ? 1 : 0);
    await expect(confirmations.confirm("owner", result.pendingActions[0]!.confirmationId)).resolves.toMatchObject({ status: "confirmed" });
    await expect(tasks.list("owner")).resolves.toMatchObject([{ title: "Persisted before failure" }]);
  });

  it.each([
    ["persisted", false, "pending_action_created"],
    ["attempted with an uncertain save", true, "outcome_unknown"],
  ] as const)("keeps a %s proposal owner-visible when conversation persistence fails", async (_label, uncertainSave, expectedEffect) => {
    let agentCalls = 0;
    let proposalSaves = 0;
    let conversationAppends = 0;
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const { service, confirmations, tasks, ideas } = setup(async (_input, context) => {
        agentCalls += 1;
        await context.tasks.propose({ kind: "create", title: "PRIVATE_PROPOSAL_PAYLOAD", project: "ASSISTANT", type: "operations" });
        return "Предложение готово к подтверждению.";
      }, {
        wrapConfirmationStore: (store) => ({
          ...store,
          async save(record) {
            proposalSaves += 1;
            await store.save(record);
            if (uncertainSave) throw new Error("PRIVATE_SAVE_FAILURE");
          },
        }),
        wrapConversationStore: (store) => ({
          ...store,
          async appendTurn() {
            conversationAppends += 1;
            throw new Error("PRIVATE_CONVERSATION_FAILURE owner-secret");
          },
        }),
      });

      const result = await service.chat({ userId: "PRIVATE_OWNER", threadId: "thread", text: "PRIVATE_USER_TEXT" });

      expect(result).toMatchObject({
        effect: expectedEffect,
        pendingActions: [{ confirmationId: "tool-confirmation-1", summary: "Создать задачу: PRIVATE_PROPOSAL_PAYLOAD" }],
      });
      expect(result.response).toMatch(uncertainSave ? /не удалось подтвердить, сохранено ли предложение задачи/i : /готово к подтверждению/i);
      expect(agentCalls).toBe(1);
      expect(proposalSaves).toBe(1);
      expect(conversationAppends).toBe(1);
      await expect(ideas.list("PRIVATE_OWNER")).resolves.toEqual([]);
      await expect(confirmations.confirm("other-owner", result.pendingActions[0]!.confirmationId)).resolves.toEqual({ status: "owner_mismatch" });
      await expect(confirmations.confirm("PRIVATE_OWNER", result.pendingActions[0]!.confirmationId)).resolves.toMatchObject({ status: "confirmed" });
      await expect(confirmations.confirm("PRIVATE_OWNER", result.pendingActions[0]!.confirmationId)).resolves.toMatchObject({ status: "already_confirmed" });
      await expect(tasks.list("PRIVATE_OWNER")).resolves.toMatchObject([{ title: "PRIVATE_PROPOSAL_PAYLOAD" }]);
      await expect(tasks.list("PRIVATE_OWNER")).resolves.toHaveLength(1);
      expect(JSON.stringify(warning.mock.calls)).not.toMatch(/PRIVATE_USER_TEXT|PRIVATE_PROPOSAL_PAYLOAD|PRIVATE_OWNER|owner-secret/);
      expect(warning).toHaveBeenCalledWith("Assistant conversation history persistence after task proposal failed (Error).");
    } finally {
      warning.mockRestore();
    }
  });

  it("keeps conversation persistence fail-fast when no task proposal exists", async () => {
    const conversationFailure = new Error("conversation unavailable");
    const { service } = setup(async () => "ordinary response", {
      wrapConversationStore: (store) => ({
        ...store,
        async appendTurn() { throw conversationFailure; },
      }),
    });

    await expect(service.chat({ userId: "owner", threadId: "thread", text: "ordinary chat" })).rejects.toBe(conversationFailure);
  });

  it("keeps an uncertain business-write effect above a persisted proposal after a downstream error", async () => {
    const { service, confirmations, tasks, ideas } = setup(async (_input, context) => {
      try {
        await context.captureIdea({
          project: "ASSISTANT",
          type: "development",
          summary: "Unknown write with proposal",
          suggestedNextStep: "Reconcile before retrying.",
          needsProjectClarification: false,
        });
      } catch {
        // Mastra may continue after a tool error.
      }
      await context.tasks.propose({ kind: "create", title: "Proposal after unknown write", project: "ASSISTANT", type: "operations" });
      throw new Error("provider connection closed");
    }, {
      wrapCaptureIdea: (captureIdea) => async (input) => {
        await captureIdea(input);
        throw new Error("capture outcome unknown");
      },
    });

    const result = await service.chat({ userId: "owner", threadId: "thread", text: "capture uncertainly and propose" });

    expect(result).toMatchObject({
      response: mutationOutcomeUnknownWithPendingActionUserMessage,
      effect: "outcome_unknown",
      pendingActions: [{ confirmationId: "tool-confirmation-1", summary: "Создать задачу: Proposal after unknown write" }],
    });
    await expect(ideas.list("owner")).resolves.toHaveLength(1);
    await expect(confirmations.confirm("owner", result.pendingActions[0]!.confirmationId)).resolves.toMatchObject({ status: "confirmed" });
    await expect(tasks.list("owner")).resolves.toMatchObject([{ title: "Proposal after unknown write" }]);
  });

  it("recovers an uncertain idea-to-task proposal without exposing canonical fields or creating a fallback idea", async () => {
    const { service, confirmations, tasks, ideas } = setup(async (_input, context) => {
      try {
        await context.tasks.proposeIdeaToTask("idea-owner");
      } catch {
        return "tool error was swallowed";
      }
      return "unreachable";
    }, {
      wrapConfirmationStore: (store) => ({
        ...store,
        async save(record) {
          await store.save(record);
          throw new Error("save outcome unknown");
        },
      }),
    });
    await ideas.add({ id: "idea-owner", userId: "owner", project: "ASSISTANT", type: "development", summary: "Convert uncertainly", status: "raw" });

    const result = await service.chat({ userId: "owner", threadId: "thread", text: "convert idea" });

    expect(result).toMatchObject({
      effect: "outcome_unknown",
      pendingActions: [{ confirmationId: "tool-confirmation-1", actionKind: "idea_to_task", summary: "Создать задачу из идеи: Convert uncertainly" }],
    });
    await expect(ideas.list("owner")).resolves.toHaveLength(1);
    await expect(confirmations.confirm("owner", result.pendingActions[0]!.confirmationId)).resolves.toMatchObject({ status: "confirmed" });
    await expect(tasks.getByOriginIdeaId("owner", "idea-owner")).resolves.toMatchObject({ title: "Convert uncertainly" });
    expect(JSON.stringify(result)).not.toMatch(/ownerId|payloadDigest|createdAt|\"proposal\"|task_idea_/);
  });

  it("prevents an adversarial agent from confirming inside the same tool loop", async () => {
    let exposedKeys: string[] = [];
    const { service, tasks } = setup(async (_input, context) => {
      exposedKeys = Object.keys(context.tasks).sort();
      const pending = await context.tasks.propose({ kind: "create", title: "Bypass attempt", project: "ASSISTANT", type: "operations" });
      expect((context.tasks as unknown as { confirm?: unknown }).confirm).toBeUndefined();
      return "confirmationId" in pending
        ? pending.confirmationId
        : pending.status === "applied"
          ? pending.task.title
          : pending.status;
    });

    await expect(service.chat({ userId: "owner", threadId: "thread", text: "propose and confirm" })).resolves.toMatchObject({
      pendingActions: [{ confirmationId: "tool-confirmation-1" }],
    });
    expect(exposedKeys).toEqual(["list", "propose", "proposeIdeaToTask", "undoLast"]);
    await expect(tasks.list("owner")).resolves.toEqual([]);
  });

  it("serializes an exact owner-free task view at the provider tool boundary", async () => {
    let providerToolResult: unknown;
    const agent: MastraAgentLike = {
      async generate(_text, options) {
        const listTasks = options.toolsets?.tasks?.listTasks as { execute?: (input: unknown, context: unknown) => Promise<unknown> };
        providerToolResult = await listTasks.execute?.({ order: "created_asc" }, {});
        return { text: JSON.stringify(providerToolResult) };
      },
    };
    const { service, tasks } = setup(createAssistantAgentRunner(agent));
    await tasks.create("PRIVATE_OWNER_ID", {
      id: "task-owner",
      title: "Visible task",
      project: "ASSISTANT",
      type: "operations",
      status: "in_progress",
      dueDate: "2026-07-30",
      originIdeaId: "PRIVATE_IDEA_PROVENANCE",
    });
    await tasks.create("other", {
      id: "PRIVATE_OTHER_TASK",
      title: "Private other-owner task",
      project: "OTHER",
      type: "personal",
      status: "open",
    });

    const result = await service.chat({ userId: "PRIVATE_OWNER_ID", threadId: "thread", text: "list tasks" });

    expect(providerToolResult).toEqual({
      tasks: [{
        id: "task-owner",
        title: "Visible task",
        project: "ASSISTANT",
        type: "operations",
        status: "in_progress",
        dueDate: "2026-07-30",
        createdAt: now,
        updatedAt: now,
        revision: 1,
      }],
    });
    expect(JSON.parse(result.response)).toEqual(providerToolResult);
    expect(Object.keys((providerToolResult as { tasks: Array<Record<string, unknown>> }).tasks[0]!)).toEqual([
      "id", "title", "project", "type", "status", "dueDate", "createdAt", "updatedAt", "revision",
    ]);
    expect(JSON.stringify(providerToolResult)).not.toMatch(/userId|ownerId|originIdeaId|PRIVATE_OWNER_ID|PRIVATE_IDEA_PROVENANCE|PRIVATE_OTHER_TASK/);
  });

  it("serializes exact provenance-free idea-to-task results at the provider tool boundary", async () => {
    const providerToolTrace: unknown[] = [];
    const agent: MastraAgentLike = {
      async generate(_text, options) {
        const proposeIdeaToTask = options.toolsets?.tasks?.proposeIdeaToTask as { execute?: (input: unknown, context: unknown) => Promise<unknown> };
        providerToolTrace.push(
          await proposeIdeaToTask.execute?.({ ideaId: "PRIVATE_ALREADY_CONVERTED_IDEA" }, {}),
          await proposeIdeaToTask.execute?.({ ideaId: "idea-pending" }, {}),
        );
        return { text: JSON.stringify(providerToolTrace) };
      },
    };
    const { service, tasks, ideas } = setup(createAssistantAgentRunner(agent));
    await ideas.add({
      id: "PRIVATE_ALREADY_CONVERTED_IDEA",
      userId: "PRIVATE_OWNER_ID",
      project: "ASSISTANT",
      type: "development",
      summary: "Private converted canonical idea",
      status: "raw",
    });
    await tasks.create("PRIVATE_OWNER_ID", {
      id: "existing-task",
      title: "Private converted canonical task",
      project: "ASSISTANT",
      type: "development",
      status: "open",
      originIdeaId: "PRIVATE_ALREADY_CONVERTED_IDEA",
    });
    await ideas.add({
      id: "idea-pending",
      userId: "PRIVATE_OWNER_ID",
      project: "SECRET_CANONICAL_PROJECT",
      type: "development",
      summary: "PRIVATE_PENDING_CANONICAL_IDEA",
      status: "raw",
    });

    const result = await service.chat({ userId: "PRIVATE_OWNER_ID", threadId: "thread", text: "convert ideas" });

    expect(providerToolTrace).toEqual([
      { status: "already_converted", taskId: "existing-task" },
      {
        status: "needs_confirmation",
        confirmation: {
          confirmationId: "tool-confirmation-1",
          actionKind: "idea_to_task",
          summary: "Создать задачу из идеи: PRIVATE_PENDING_CANONICAL_IDEA",
          expiresAt: "2026-07-28T12:15:00.000Z",
        },
      },
    ]);
    expect(JSON.parse(result.response)).toEqual(providerToolTrace);
    expect(Object.keys(providerToolTrace[0] as Record<string, unknown>)).toEqual(["status", "taskId"]);
    expect(Object.keys((providerToolTrace[1] as { status: string; confirmation: Record<string, unknown> }).confirmation)).toEqual([
      "confirmationId", "actionKind", "summary", "expiresAt",
    ]);
    expect(JSON.stringify(providerToolTrace)).not.toMatch(/originIdeaId|ownerId|PRIVATE_OWNER_ID|PRIVATE_ALREADY_CONVERTED_IDEA|SECRET_CANONICAL_PROJECT|task_idea_|payloadDigest|createdAt|"proposal"/);
    await expect(tasks.getByOriginIdeaId("PRIVATE_OWNER_ID", "PRIVATE_ALREADY_CONVERTED_IDEA")).resolves.toMatchObject({
      id: "existing-task",
      userId: "PRIVATE_OWNER_ID",
      originIdeaId: "PRIVATE_ALREADY_CONVERTED_IDEA",
    });
    await expect(tasks.getByOriginIdeaId("PRIVATE_OWNER_ID", "idea-pending")).resolves.toBeNull();
    expect(result.pendingActions[0]).toMatchObject({
      confirmationId: "tool-confirmation-1",
      preview: {
        kind: "idea_to_task",
        title: { value: "PRIVATE_PENDING_CANONICAL_IDEA", truncated: false },
        project: { value: "SECRET_CANONICAL_PROJECT", truncated: false },
        type: "development",
        dueDate: null,
      },
    });
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
    const parsed = JSON.parse(result.response) as { ids: string[]; conversion: { status: string; confirmation: { confirmationId: string; actionKind: string; summary: string; expiresAt: string } } };
    expect(parsed.ids).toEqual(["task-owner"]);
    expect(parsed.conversion).toMatchObject({
      status: "needs_confirmation",
      confirmation: { actionKind: "idea_to_task", summary: "Создать задачу из идеи: Convert me" },
    });
    expect(parsed.conversion).not.toHaveProperty("taskId");
    expect(parsed.conversion).not.toHaveProperty("originIdeaId");
    expect(JSON.stringify(parsed.conversion)).not.toMatch(/ownerId|proposal|payloadDigest|task_idea_|createdAt/);
    expect(parsed.conversion.confirmation).not.toHaveProperty("preview");
    expect(result.pendingActions[0]).toMatchObject({ ...parsed.conversion.confirmation, preview: { kind: "idea_to_task", title: { value: "Convert me", truncated: false }, project: { value: "ASSISTANT", truncated: false }, type: "development", dueDate: null } });
    await expect(tasks.getByOriginIdeaId("owner", "idea-owner")).resolves.toBeNull();
  });
});
