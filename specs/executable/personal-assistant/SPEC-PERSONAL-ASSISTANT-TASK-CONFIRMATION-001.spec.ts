import { describe, expect, it } from "vitest";
import { createInMemoryTaskMutationConfirmationStore } from "../../../src/application/in-memory-task-mutation-confirmation-store.js";
import { createInMemoryTaskStore } from "../../../src/application/in-memory-task-store.js";
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
  const service = new TaskMutationConfirmationService(
    createInMemoryTaskMutationConfirmationStore(tasks),
    clock,
    { ttlMilliseconds: 60_000, confirmationId: () => `confirmation-${++sequence}` },
  );
  return { tasks, service, setNow(value: string) { now = value; } };
}

describe("SPEC-PERSONAL-ASSISTANT-TASK-CONFIRMATION-001: durable task confirmation boundary", () => {
  it("does not create, update or cancel before explicit confirmation", async () => {
    const { service, tasks } = harness();
    const create = await service.propose("owner", createProposal);
    expect(await tasks.list("owner")).toEqual([]);

    await service.confirm("owner", create.confirmationId, create.proposal);
    const update = await service.propose("owner", { kind: "update", taskId: "task-1", expectedRevision: 1, patch: { title: "Новый план" } });
    const cancel = await service.propose("owner", { kind: "cancel", taskId: "task-1", expectedRevision: 1 });
    await expect(tasks.get("owner", "task-1")).resolves.toMatchObject({ title: "Подготовить план", status: "open", revision: 1 });
    expect(update.proposal.kind).toBe("update");
    expect(cancel.proposal.kind).toBe("cancel");
  });

  it("fails closed for another owner, expiration and payload drift", async () => {
    const { service, tasks, setNow } = harness();
    const pending = await service.propose("owner", createProposal);

    await expect(service.confirm("other", pending.confirmationId, pending.proposal)).resolves.toEqual({ status: "owner_mismatch" });
    await expect(service.confirm("owner", pending.confirmationId, { ...createProposal, input: { ...createProposal.input, title: "Подменено" } })).resolves.toEqual({ status: "payload_mismatch" });
    setNow("2026-07-28T09:01:00.000Z");
    await expect(service.confirm("owner", pending.confirmationId, pending.proposal)).resolves.toEqual({ status: "expired" });
    await expect(tasks.list("owner")).resolves.toEqual([]);
  });

  it("executes concurrent double confirmation exactly once and returns a stable outcome", async () => {
    const { service, tasks } = harness();
    const pending = await service.propose("owner", createProposal);

    const results = await Promise.all([
      service.confirm("owner", pending.confirmationId, pending.proposal),
      service.confirm("owner", pending.confirmationId, pending.proposal),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["already_confirmed", "confirmed"]);
    expect(results[0]).toMatchObject({ outcome: { outcome: "created", task: { id: "task-1", revision: 1 } } });
    expect(results[1]).toMatchObject({ outcome: { outcome: "created", task: { id: "task-1", revision: 1 } } });
    await expect(tasks.list("owner")).resolves.toHaveLength(1);
  });

  it("binds update and cancel to the proposed revision", async () => {
    const { service, tasks } = harness();
    const create = await service.propose("owner", createProposal);
    await service.confirm("owner", create.confirmationId, create.proposal);

    const update = await service.propose("owner", { kind: "update", taskId: "task-1", expectedRevision: 1, patch: { status: "in_progress" } });
    await expect(service.confirm("owner", update.confirmationId, update.proposal)).resolves.toMatchObject({ status: "confirmed", outcome: { outcome: "updated", task: { revision: 2, status: "in_progress" } } });

    const staleCancel = await service.propose("owner", { kind: "cancel", taskId: "task-1", expectedRevision: 1 });
    await expect(service.confirm("owner", staleCancel.confirmationId, staleCancel.proposal)).resolves.toMatchObject({ status: "confirmed", outcome: { outcome: "conflict", current: { revision: 2 } } });
    await expect(tasks.get("owner", "task-1")).resolves.toMatchObject({ status: "in_progress" });
  });
});
