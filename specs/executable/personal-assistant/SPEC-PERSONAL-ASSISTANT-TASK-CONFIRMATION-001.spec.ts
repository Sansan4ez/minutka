import { describe, expect, it } from "vitest";
import { createInMemoryTaskMutationConfirmationStore } from "../../../src/application/in-memory-task-mutation-confirmation-store.js";
import { createInMemoryTaskStore } from "../../../src/application/in-memory-task-store.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createDeterministicIdGenerator } from "../../../src/application/runtime-primitives.js";
import { pendingTaskAction, pendingTaskPreviewValueMaximumCharacters, pendingTaskReceipt, safeConfirmationDisplayText, TaskMutationConfirmationService, type TaskMutationProposal } from "../../../src/application/task-mutation-confirmation.js";
import { EmployeeMinutkaClient, type EmployeeMinutkaTransport } from "../../../src/client/sdk/minutka-client.js";
import { chatResponseSchema, pendingActionSchema, pendingTaskReceiptSchema } from "../../../src/contracts/minutka-api.js";
import { countUnicodeCodePoints, pendingTaskSummaryMaximumCodePoints } from "../../../src/shared/chat-limits.js";

const createProposal: TaskMutationProposal = {
  kind: "create",
  input: { id: "task-1", title: "Подготовить план", project: "АССИСТЕНТ", type: "operations", status: "open" },
};

function harness(start = "2026-07-28T09:00:00.000Z") {
  let now = start;
  let sequence = 0;
  const clock = { now: () => now };
  const tasks = createInMemoryTaskStore(clock);
  const store = createInMemoryTaskMutationConfirmationStore(tasks);
  const service = new TaskMutationConfirmationService(
    store,
    clock,
    { ttlMilliseconds: 60_000, confirmationId: () => `confirmation-${++sequence}` },
  );
  return { tasks, store, service, setNow(value: string) { now = value; } };
}

describe("SPEC-PERSONAL-ASSISTANT-TASK-CONFIRMATION-001: durable task confirmation boundary", () => {
  it("does not create, update or cancel before authenticated confirmation", async () => {
    const { service, tasks } = harness();
    const create = await service.propose("owner", createProposal);
    expect(await tasks.list("owner")).toEqual([]);

    await service.confirm("owner", create.confirmationId);
    const update = await service.propose("owner", { kind: "update", taskId: "task-1", expectedRevision: 1, patch: { title: "Новый план" } });
    const cancel = await service.propose("owner", { kind: "cancel", taskId: "task-1", expectedRevision: 1 });
    await expect(tasks.get("owner", "task-1")).resolves.toMatchObject({ title: "Подготовить план", status: "open", revision: 1 });
    expect(update.proposal.kind).toBe("update");
    expect(cancel.proposal.kind).toBe("cancel");
  });

  it("builds bounded owner previews from every canonical proposal kind", async () => {
    const { service } = harness();
    const create = pendingTaskAction(await service.propose("owner", { ...createProposal, input: { ...createProposal.input, dueDate: "2026-08-01" } }));
    expect(create.preview).toEqual({ kind: "create", title: { value: "Подготовить план", truncated: false }, project: { value: "АССИСТЕНТ", truncated: false }, type: "operations", dueDate: "2026-08-01" });
    const ideaToTask = pendingTaskAction(await service.propose("owner", { ...createProposal, input: { ...createProposal.input, id: "idea-task", originIdeaId: "idea-1" } }, { actionKind: "idea_to_task" }));
    expect(ideaToTask.preview).toMatchObject({ kind: "idea_to_task", title: { value: "Подготовить план", truncated: false }, project: { value: "АССИСТЕНТ", truncated: false }, type: "operations", dueDate: null });

    const update = pendingTaskAction(await service.propose("owner", {
      kind: "update",
      taskId: "task-1",
      expectedRevision: 1,
      patch: { title: "Новый план", project: "ПРОЕКТ", type: "development", status: "in_progress", dueDate: null },
    }), "Подготовить план");
    expect(update.preview).toEqual({
      kind: "update",
      taskId: { value: "task-1", truncated: false },
      taskTitle: { value: "Подготовить план", truncated: false },
      fields: [
        { field: "title", value: { value: "Новый план", truncated: false } },
        { field: "project", value: { value: "ПРОЕКТ", truncated: false } },
        { field: "type", value: "development" },
        { field: "status", value: "in_progress" },
        { field: "dueDate", value: null },
      ],
    });
    expect(pendingTaskAction(await service.propose("owner", { kind: "update", taskId: "task-1", expectedRevision: 1, patch: { status: "done" } }, { actionKind: "complete" }), "Подготовить план").preview).toEqual({ kind: "complete", taskId: { value: "task-1", truncated: false }, taskTitle: { value: "Подготовить план", truncated: false } });
    expect(pendingTaskAction(await service.propose("owner", { kind: "cancel", taskId: "task-1", expectedRevision: 1 }), "Подготовить план").preview).toEqual({ kind: "cancel", taskId: { value: "task-1", truncated: false }, taskTitle: { value: "Подготовить план", truncated: false } });
  });

  it.each([
    ["bidi override", "left\u202Eright", "left<U+202E>right"],
    ["bidi isolates", "a\u2066b\u2067c\u2068d\u2069e", "a<U+2066>b<U+2067>c<U+2068>d<U+2069>e"],
    ["zero-width formats", "a\u200Bb\u200Cc\u200Dd", "a<U+200B>b<U+200C>c<U+200D>d"],
    ["ordinary whitespace", "  a\n\tb\u2003c  ", "a b c"],
    ["C0 control", "a\u0001b", "a<U+0001>b"],
    ["C1 control", "a\u0085b", "a<U+0085>b"],
  ])("projects %s into deterministic printable owner text", (_case, canonical, expected) => {
    expect(safeConfirmationDisplayText(canonical)).toEqual({ value: expected, truncated: false });
  });

  it("uses the same safe display projection for every user-controlled preview field without changing canonical values", async () => {
    const { service } = harness();
    const unsafe = "left\u202Eright\u200D\u0001";
    const expected = "left<U+202E>right<U+200D><U+0001>";
    const createPending = await service.propose("owner", { ...createProposal, input: { ...createProposal.input, title: unsafe, project: unsafe } });
    expect(pendingTaskAction(createPending).preview).toMatchObject({ kind: "create", title: { value: expected }, project: { value: expected } });
    expect(createPending.proposal).toMatchObject({ input: { title: unsafe, project: unsafe } });

    const ideaPending = await service.propose("owner", { ...createProposal, input: { ...createProposal.input, id: "idea-task", title: unsafe, project: unsafe, originIdeaId: "idea-1" } }, { actionKind: "idea_to_task" });
    expect(pendingTaskAction(ideaPending).preview).toMatchObject({ kind: "idea_to_task", title: { value: expected }, project: { value: expected } });

    const updatePending = await service.propose("owner", { kind: "update", taskId: unsafe, expectedRevision: 1, patch: { title: unsafe, project: unsafe } });
    expect(pendingTaskAction(updatePending, unsafe).preview).toEqual({
      kind: "update",
      taskId: { value: expected, truncated: false },
      taskTitle: { value: expected, truncated: false },
      fields: [
        { field: "title", value: { value: expected, truncated: false } },
        { field: "project", value: { value: expected, truncated: false } },
      ],
    });
    expect(pendingTaskAction(await service.propose("owner", { kind: "update", taskId: unsafe, expectedRevision: 1, patch: { status: "done" } }, { actionKind: "complete" }), unsafe).preview).toEqual({ kind: "complete", taskId: { value: expected, truncated: false }, taskTitle: { value: expected, truncated: false } });
    expect(pendingTaskAction(await service.propose("owner", { kind: "cancel", taskId: unsafe, expectedRevision: 1 }), unsafe).preview).toEqual({ kind: "cancel", taskId: { value: expected, truncated: false }, taskTitle: { value: expected, truncated: false } });
  });

  it("clips escaped owner preview text on Unicode code-point boundaries and marks truncation", async () => {
    const { service } = harness();
    const escapedPrefix = "a".repeat(pendingTaskPreviewValueMaximumCharacters - 7);
    const title = `${escapedPrefix}\u202Eend`;
    const action = pendingTaskAction(await service.propose("owner", { ...createProposal, input: { ...createProposal.input, title } }));
    expect(action.preview).toMatchObject({ title: { value: `${escapedPrefix}<U+202E`, truncated: true } });
  });

  it("uses one Unicode code-point limit from producer through tool, chat and SDK schemas", async () => {
    const { service } = harness();
    const pending = await service.propose("owner", {
      ...createProposal,
      input: { ...createProposal.input, title: "🙂".repeat(pendingTaskSummaryMaximumCodePoints + 1) },
    });
    const receipt = pendingTaskReceipt(pending);
    const action = pendingTaskAction(pending);
    const response = { messageId: "msg", response: "proposal", selectedProcessIds: ["core", "inbox_capture"] as const, pendingActions: [action], effect: "pending_action_created" as const };

    expect(countUnicodeCodePoints(receipt.summary)).toBe(pendingTaskSummaryMaximumCodePoints);
    expect(pendingTaskReceiptSchema.safeParse(receipt).success).toBe(true);
    expect(chatResponseSchema.safeParse(response).success).toBe(true);
    expect(pendingTaskReceiptSchema.safeParse({ ...receipt, summary: "🙂".repeat(pendingTaskSummaryMaximumCodePoints) }).success).toBe(true);
    expect(pendingTaskReceiptSchema.safeParse({ ...receipt, summary: "🙂".repeat(pendingTaskSummaryMaximumCodePoints + 1) }).success).toBe(false);
    expect(pendingTaskReceiptSchema.safeParse({ ...receipt, summary: "a".repeat(pendingTaskSummaryMaximumCodePoints) }).success).toBe(true);
    expect(pendingTaskReceiptSchema.safeParse({ ...receipt, summary: "a".repeat(pendingTaskSummaryMaximumCodePoints + 1) }).success).toBe(false);

    const transport = { chat: async () => response } as unknown as EmployeeMinutkaTransport;
    await expect(new EmployeeMinutkaClient(transport).chat({ threadId: "thread", text: "hello" })).resolves.toEqual(response);
  });

  it("keeps task, idea, and context-document pending action contracts distinct", () => {
    const common = { confirmationId: "confirmation-1", summary: "Предложение", expiresAt: "2026-07-28T09:15:00.000Z" };
    const contextAction = {
      ...common,
      actionKind: "update",
      preview: {
        path: "/proc/context/00_inbox/source.md",
        change: {
          removed: { value: "- old", truncated: false },
          added: { value: "+ new", truncated: false },
        },
      },
    };

    expect(pendingActionSchema.safeParse(contextAction).success).toBe(true);
    expect(pendingActionSchema.safeParse({ ...contextAction, actionKind: "create" }).success).toBe(false);
    expect(pendingActionSchema.safeParse({
      ...common,
      actionKind: "delete_idea",
      preview: { kind: "delete_idea", ideaId: { value: "idea-1", truncated: false }, summary: { value: "idea", truncated: false }, revision: 1 },
    }).success).toBe(true);
    expect(pendingActionSchema.safeParse({
      ...common,
      actionKind: "create",
      preview: { kind: "create", title: { value: "Task", truncated: false }, project: { value: "ASSISTANT", truncated: false }, type: "operations", dueDate: null },
    }).success).toBe(true);
  });

  it("fails closed for another owner and expiration without a client payload", async () => {
    const { service, tasks, setNow } = harness();
    const pending = await service.propose("owner", createProposal);

    await expect(service.confirm("other", pending.confirmationId)).resolves.toEqual({ status: "owner_mismatch" });
    setNow("2026-07-28T09:01:00.000Z");
    await expect(service.confirm("owner", pending.confirmationId)).resolves.toEqual({ status: "expired" });
    await expect(tasks.list("owner")).resolves.toEqual([]);
  });

  it("persists terminal rejection and never executes it", async () => {
    const { service, tasks } = harness();
    const pending = await service.propose("owner", createProposal);

    await expect(service.reject("owner", pending.confirmationId)).resolves.toEqual({ status: "rejected" });
    await expect(service.reject("owner", pending.confirmationId)).resolves.toEqual({ status: "already_rejected" });
    await expect(service.confirm("owner", pending.confirmationId)).resolves.toEqual({ status: "already_rejected" });
    await expect(tasks.list("owner")).resolves.toEqual([]);
  });

  it("executes concurrent double confirmation exactly once and returns a stable outcome", async () => {
    const { service, tasks } = harness();
    const pending = await service.propose("owner", createProposal);

    const results = await Promise.all([
      service.confirm("owner", pending.confirmationId),
      service.confirm("owner", pending.confirmationId),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["already_confirmed", "confirmed"]);
    expect(results[0]).toMatchObject({ outcome: { outcome: "created", task: { id: "task-1", revision: 1 } } });
    expect(results[1]).toMatchObject({ outcome: { outcome: "created", task: { id: "task-1", revision: 1 } } });
    await expect(tasks.list("owner")).resolves.toHaveLength(1);
  });

  it("purges expired pending and old terminal rows in bounded batches while keeping recent replay", async () => {
    const { service, setNow } = harness();
    const expired = await service.propose("owner", createProposal);
    setNow("2026-07-28T09:02:00.000Z");
    const rejected = await service.propose("owner", { ...createProposal, input: { ...createProposal.input, id: "task-2" } });
    await service.reject("owner", rejected.confirmationId);
    setNow("2026-07-28T09:03:00.000Z");
    const recent = await service.propose("owner", { ...createProposal, input: { ...createProposal.input, id: "task-3" } });
    await service.confirm("owner", recent.confirmationId);

    setNow("2026-07-28T09:05:00.000Z");
    await expect(service.purge({ completedReplayRetentionMilliseconds: 150_000, limit: 1 })).resolves.toBe(1);
    await expect(service.confirm("owner", expired.confirmationId)).resolves.toEqual({ status: "not_found" });
    await expect(service.purge({ completedReplayRetentionMilliseconds: 150_000, limit: 10 })).resolves.toBe(1);
    await expect(service.confirm("owner", rejected.confirmationId)).resolves.toEqual({ status: "not_found" });
    await expect(service.confirm("owner", recent.confirmationId)).resolves.toMatchObject({ status: "already_confirmed", outcome: { outcome: "created" } });
  });

  it("writes allow-listed proposal and terminal audit facts without task content", async () => {
    let now = "2026-07-28T09:00:00.000Z";
    const world = createInMemoryWorld(() => now);
    const tasks = createInMemoryTaskStore({ now: () => now });
    const service = new TaskMutationConfirmationService(
      createInMemoryTaskMutationConfirmationStore(tasks),
      { now: () => now },
      {
        confirmationId: () => "confirmation-audit",
        auditEventStore: createInMemoryAuditEventStore(world),
        idGenerator: createDeterministicIdGenerator(),
      },
    );
    const pending = await service.propose("owner", createProposal, { audit: { requestId: "req-proposal", threadId: "thread", messageId: "message" } });
    now = "2026-07-28T09:01:00.000Z";
    await service.confirm("owner", pending.confirmationId, { requestId: "req-confirm", threadId: "thread" });

    expect(world.auditEvents.map(({ type, requestId, metadata }) => ({ type, requestId, metadata }))).toEqual([
      { type: "task_mutation_proposed", requestId: "req-proposal", metadata: { confirmationId: "confirmation-audit", actionKind: "create", status: "pending", taskId: "task-1" } },
      { type: "task_mutation_decided", requestId: "req-confirm", metadata: { confirmationId: "confirmation-audit", actionKind: "create", status: "confirmed", result: "created", taskId: "task-1" } },
    ]);
    const serialized = JSON.stringify(world.auditEvents);
    expect(serialized).not.toContain("Подготовить план");
    expect(serialized).not.toContain("АССИСТЕНТ");
    expect(serialized).not.toContain("payload");
    expect(serialized).not.toContain("ownerId");
  });

  it("rejects update proposals whose patch has no defined fields before persistence", async () => {
    const { service, store } = harness();

    await expect(service.propose("owner", {
      kind: "update",
      taskId: "task-1",
      expectedRevision: 1,
      patch: { status: undefined },
    })).rejects.toThrow("Task patch must not be empty");
    await expect(store.purge({ pendingExpiredBefore: "9999-12-31T23:59:59.999Z", completedBefore: "9999-12-31T23:59:59.999Z", limit: 10 })).resolves.toBe(0);
  });

  it("binds update and cancel to the canonical proposed revision", async () => {
    const { service, tasks } = harness();
    const create = await service.propose("owner", createProposal);
    await service.confirm("owner", create.confirmationId);

    const update = await service.propose("owner", { kind: "update", taskId: "task-1", expectedRevision: 1, patch: { status: "in_progress" } });
    await expect(service.confirm("owner", update.confirmationId)).resolves.toMatchObject({ status: "confirmed", outcome: { outcome: "updated", task: { revision: 2, status: "in_progress" } } });

    const staleCancel = await service.propose("owner", { kind: "cancel", taskId: "task-1", expectedRevision: 1 });
    await expect(service.confirm("owner", staleCancel.confirmationId)).resolves.toMatchObject({ status: "confirmed", outcome: { outcome: "conflict", current: { revision: 2 } } });
    await expect(tasks.get("owner", "task-1")).resolves.toMatchObject({ status: "in_progress" });
  });
});
