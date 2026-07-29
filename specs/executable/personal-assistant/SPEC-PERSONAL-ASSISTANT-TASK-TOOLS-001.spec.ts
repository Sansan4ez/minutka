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
import { createIngestionService, type IngestionService } from "../../../src/application/ingestion-service.js";
import { IdeaToTaskService } from "../../../src/application/idea-to-task.js";
import { createDeterministicIdGenerator } from "../../../src/application/runtime-primitives.js";
import { TaskMutationConfirmationService, type TaskMutationConfirmationStore } from "../../../src/application/task-mutation-confirmation.js";
import { overflowAfterDurableWriteAndPendingActionUserMessage, overflowAfterPendingActionUserMessage } from "../../../src/application/assistant-overflow-recovery.js";
import { mutationOutcomeUnknownWithPendingActionUserMessage } from "../../../src/application/assistant-mutation-outcome.js";

const now = "2026-07-28T12:00:00.000Z";

function setup(
  runner: ConstructorParameters<typeof AssistantService>[0],
  options: {
    wrapConfirmationStore?: (store: TaskMutationConfirmationStore) => TaskMutationConfirmationStore;
    wrapCaptureIdea?: (captureIdea: IngestionService["captureIdea"]) => IngestionService["captureIdea"];
    exposeIdeaStore?: boolean;
  } = {},
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
    ingestionService: options.wrapCaptureIdea === undefined
      ? ingestion
      : { ...ingestion, captureIdea: options.wrapCaptureIdea(ingestion.captureIdea) },
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
      pendingAction: {
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
      },
    });
    expect(result.pendingAction).not.toHaveProperty("ownerId");
    expect(result.pendingAction).not.toHaveProperty("proposal");
    expect(result.pendingAction).not.toHaveProperty("payloadDigest");
    await expect(tasks.list("owner")).resolves.toEqual([]);
    expect(modelVisible).not.toHaveProperty("preview");
    expect(modelVisible).toMatchObject({ confirmationId: result.pendingAction!.confirmationId, actionKind: "create", summary: "Создать задачу: Prepare launch" });
    expect(JSON.stringify(modelVisible)).not.toMatch(/ownerId|proposal|payloadDigest|task_1|createdAt|preview|dueDate/);

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
      pendingAction: { confirmationId: "tool-confirmation-1", summary: `Создать задачу: Proposal ${order}` },
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
      pendingAction: { confirmationId: "tool-confirmation-1", summary: "Создать задачу: Proposal before uncertainty" },
    });
    expect(calls).toBe(1);
    await expect(ideas.list("owner")).resolves.toMatchObject([{ summary: "Committed before result was lost" }]);
    await expect(tasks.list("owner")).resolves.toEqual([]);
    await expect(confirmations.confirm("owner", result.pendingAction!.confirmationId)).resolves.toMatchObject({ status: "confirmed" });
    await expect(tasks.list("owner")).resolves.toMatchObject([{ title: "Proposal before uncertainty" }]);
    expect(JSON.stringify(result)).not.toMatch(/ownerId|payloadDigest|createdAt|\"proposal\"/);
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

    await expect(service.chat({ userId: "owner", threadId: "thread", text: "two proposals" })).resolves.toMatchObject({
      response: expect.stringMatching(/предложение задачи сохранено/i),
      effect: "pending_action_created",
      pendingAction: { confirmationId: "tool-confirmation-1" },
    });
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
      pendingAction: { confirmationId: "tool-confirmation-1", actionKind: "create", summary: "Создать задачу: Uncertain" },
    });
    expect(calls).toBe(1);
    expect(saveCount).toBe(1);
    expect(world.auditEvents.filter(({ type }) => type === "task_mutation_proposed")).toHaveLength(0);
    await expect(ideas.list("owner")).resolves.toEqual([]);
    await expect(confirmations.confirm("owner", result.pendingAction!.confirmationId)).resolves.toMatchObject(
      commits ? { status: "confirmed" } : { status: "not_found" },
    );
    await expect(tasks.list("owner")).resolves.toHaveLength(commits ? 1 : 0);
    expect(JSON.stringify(result)).not.toMatch(/ownerId|payloadDigest|createdAt|\"proposal\"|task_1/);
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

    expect(result).toMatchObject({ effect: "outcome_unknown", pendingAction: { confirmationId: "tool-confirmation-1" } });
    expect(secondError).toEqual(new Error("only one task proposal is allowed per assistant turn"));
    expect(saveCount).toBe(1);
    await expect(confirmations.confirm("owner", "tool-confirmation-2")).resolves.toEqual({ status: "not_found" });
    await expect(confirmations.confirm("owner", result.pendingAction!.confirmationId)).resolves.toMatchObject({ status: "confirmed" });
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
      pendingAction: { confirmationId: "tool-confirmation-1", summary: "Создать задачу: Persisted before failure" },
    });
    expect(calls).toBe(1);
    await expect(ideas.list("owner")).resolves.toHaveLength(captureFirst ? 1 : 0);
    await expect(confirmations.confirm("owner", result.pendingAction!.confirmationId)).resolves.toMatchObject({ status: "confirmed" });
    await expect(tasks.list("owner")).resolves.toMatchObject([{ title: "Persisted before failure" }]);
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
      pendingAction: { confirmationId: "tool-confirmation-1", summary: "Создать задачу: Proposal after unknown write" },
    });
    await expect(ideas.list("owner")).resolves.toHaveLength(1);
    await expect(confirmations.confirm("owner", result.pendingAction!.confirmationId)).resolves.toMatchObject({ status: "confirmed" });
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
      pendingAction: { confirmationId: "tool-confirmation-1", actionKind: "idea_to_task", summary: "Создать задачу из идеи: Convert uncertainly" },
    });
    await expect(ideas.list("owner")).resolves.toHaveLength(1);
    await expect(confirmations.confirm("owner", result.pendingAction!.confirmationId)).resolves.toMatchObject({ status: "confirmed" });
    await expect(tasks.getByOriginIdeaId("owner", "idea-owner")).resolves.toMatchObject({ title: "Convert uncertainly" });
    expect(JSON.stringify(result)).not.toMatch(/ownerId|payloadDigest|createdAt|\"proposal\"|task_idea_/);
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
    expect(result.pendingAction).toMatchObject({ ...parsed.conversion.confirmation, preview: { kind: "idea_to_task", title: { value: "Convert me", truncated: false }, project: { value: "ASSISTANT", truncated: false }, type: "development", dueDate: null } });
    await expect(tasks.getByOriginIdeaId("owner", "idea-owner")).resolves.toBeNull();
  });
});
