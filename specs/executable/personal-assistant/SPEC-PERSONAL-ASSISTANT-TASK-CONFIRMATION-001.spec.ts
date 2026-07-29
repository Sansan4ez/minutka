import { describe, expect, it } from "vitest";
import { createInMemoryTaskMutationConfirmationStore } from "../../../src/application/in-memory-task-mutation-confirmation-store.js";
import { createInMemoryTaskStore } from "../../../src/application/in-memory-task-store.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createDeterministicIdGenerator } from "../../../src/application/runtime-primitives.js";
import { TaskMutationConfirmationService, type TaskMutationProposal } from "../../../src/application/task-mutation-confirmation.js";

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
