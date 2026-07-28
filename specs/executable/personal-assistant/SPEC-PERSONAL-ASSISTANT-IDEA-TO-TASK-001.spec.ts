import { describe, expect, it } from "vitest";
import { IdeaToTaskService } from "../../../src/application/idea-to-task.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";
import { createInMemoryTaskMutationConfirmationStore } from "../../../src/application/in-memory-task-mutation-confirmation-store.js";
import { createInMemoryTaskStore } from "../../../src/application/in-memory-task-store.js";
import { TaskMutationConfirmationService } from "../../../src/application/task-mutation-confirmation.js";

function harness() {
  const clock = { now: () => "2026-07-28T09:00:00.000Z" };
  const ideas = createInMemoryIdeaStore(clock);
  const tasks = createInMemoryTaskStore(clock);
  let confirmationId = 0;
  const confirmationStore = createInMemoryTaskMutationConfirmationStore(tasks);
  const confirmations = new TaskMutationConfirmationService(confirmationStore, clock, {
    confirmationId: () => `idea-task-confirmation-${++confirmationId}`,
  });
  const createService = () => new IdeaToTaskService(ideas, tasks, confirmations);
  return { ideas, tasks, confirmations, createService };
}

async function addIdea(ideas: ReturnType<typeof createInMemoryIdeaStore>, userId = "owner", id = "idea-1") {
  return ideas.add({ id, userId, project: "АССИСТЕНТ", type: "development", summary: "Собрать план запуска", status: "raw" });
}

describe("SPEC-PERSONAL-ASSISTANT-IDEA-TO-TASK-001: confirmed idea conversion", () => {
  it("fails closed for unknown and other-owner ideas", async () => {
    const { ideas, tasks, createService } = harness();
    await addIdea(ideas, "other", "private-idea");
    const service = createService();

    await expect(service.propose("owner", "missing")).resolves.toEqual({ status: "not_found" });
    await expect(service.propose("owner", "private-idea")).resolves.toEqual({ status: "not_found" });
    await expect(tasks.list("owner")).resolves.toEqual([]);
  });

  it("derives the owner-bound task payload from the stored idea and preserves provenance", async () => {
    const { ideas, tasks, createService } = harness();
    await addIdea(ideas);
    const service = createService();
    const proposed = await service.propose("owner", "idea-1");
    expect(proposed).toMatchObject({
      status: "needs_confirmation",
      taskId: expect.stringMatching(/^task_idea_[0-9a-f]{32}$/),
      originIdeaId: "idea-1",
      confirmation: { ownerId: "owner", proposal: { kind: "create", input: { title: "Собрать план запуска", originIdeaId: "idea-1" } } },
    });
    await expect(tasks.list("owner")).resolves.toEqual([]);
    if (proposed.status !== "needs_confirmation") throw new Error("expected confirmation");

    await expect(service.confirm("owner", proposed.confirmation.confirmationId, proposed.confirmation)).resolves.toEqual({
      status: "confirmed", outcome: "created", taskId: proposed.taskId, originIdeaId: "idea-1",
    });
    await expect(tasks.get("owner", proposed.taskId)).resolves.toMatchObject({ userId: "owner", originIdeaId: "idea-1" });
    await expect(ideas.get("owner", "idea-1")).resolves.toMatchObject({ status: "raw" });
  });

  it("does not let a caller substitute the owner and does not duplicate conversion", async () => {
    const { ideas, tasks, createService } = harness();
    await addIdea(ideas);
    const service = createService();
    const proposed = await service.propose("owner", "idea-1");
    if (proposed.status !== "needs_confirmation") throw new Error("expected confirmation");

    await expect(service.confirm("other", proposed.confirmation.confirmationId, proposed.confirmation)).resolves.toEqual({ status: "owner_mismatch" });
    if (proposed.confirmation.proposal.kind !== "create") throw new Error("expected create proposal");
    const tampered = {
      ...proposed.confirmation,
      ownerId: "other",
      proposal: { ...proposed.confirmation.proposal, input: { ...proposed.confirmation.proposal.input, title: "Подменено" } },
    };
    await expect(service.confirm("owner", proposed.confirmation.confirmationId, tampered)).resolves.toEqual({ status: "payload_mismatch" });
    await service.confirm("owner", proposed.confirmation.confirmationId, proposed.confirmation);
    await expect(service.confirm("owner", proposed.confirmation.confirmationId, proposed.confirmation)).resolves.toEqual({
      status: "already_confirmed", outcome: "created", taskId: proposed.taskId, originIdeaId: "idea-1",
    });
    await expect(service.propose("owner", "idea-1")).resolves.toEqual({ status: "already_converted", taskId: proposed.taskId, originIdeaId: "idea-1" });
    await expect(tasks.list("owner")).resolves.toHaveLength(1);
  });

  it("uses a stable task id so repeated proposals after a restart converge without a second task", async () => {
    const { ideas, tasks, createService } = harness();
    await addIdea(ideas);
    const first = createService();
    const firstProposal = await first.propose("owner", "idea-1");
    if (firstProposal.status !== "needs_confirmation") throw new Error("expected confirmation");

    const restarted = createService();
    const secondProposal = await restarted.propose("owner", "idea-1");
    if (secondProposal.status !== "needs_confirmation") throw new Error("expected confirmation");
    expect(secondProposal.taskId).toBe(firstProposal.taskId);

    await restarted.confirm("owner", secondProposal.confirmation.confirmationId, secondProposal.confirmation);
    await expect(first.confirm("owner", firstProposal.confirmation.confirmationId, firstProposal.confirmation)).resolves.toEqual({
      status: "confirmed", outcome: "unchanged", taskId: firstProposal.taskId, originIdeaId: "idea-1",
    });
    await expect(tasks.list("owner")).resolves.toHaveLength(1);
  });

  it("recovers the durable confirmation outcome after an application restart without retrying the write", async () => {
    const { ideas, tasks, confirmations, createService } = harness();
    await addIdea(ideas);
    const first = createService();
    const proposed = await first.propose("owner", "idea-1");
    if (proposed.status !== "needs_confirmation") throw new Error("expected confirmation");
    await confirmations.confirm("owner", proposed.confirmation.confirmationId, proposed.confirmation.proposal);

    const restarted = createService();
    await expect(restarted.confirm("owner", proposed.confirmation.confirmationId, proposed.confirmation)).resolves.toEqual({
      status: "already_confirmed", outcome: "created", taskId: proposed.taskId, originIdeaId: "idea-1",
    });
    await expect(tasks.list("owner")).resolves.toHaveLength(1);
  });
});
