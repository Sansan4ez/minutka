import { describe, expect, it } from "vitest";
import { createInMemoryTaskStore } from "../../../src/application/in-memory-task-store.js";
import type { CreateTaskInput } from "../../../src/application/task-store.js";

const baseTask: CreateTaskInput = {
  id: "task-1",
  title: "Подготовить план",
  project: "АССИСТЕНТ",
  type: "operations",
  status: "open",
};

describe("SPEC-PERSONAL-ASSISTANT-TASK-STORE-001: owner-scoped task records", () => {
  it("creates, gets and lists tasks in stable order without taking userId from the record payload", async () => {
    let now = "2026-07-28T09:00:00.000Z";
    const store = createInMemoryTaskStore({ now: () => now });

    await expect(store.create("maxim", { ...baseTask, id: "later-id" })).resolves.toMatchObject({
      outcome: "created",
      task: { userId: "maxim", revision: 1, createdAt: now, updatedAt: now },
    });
    await expect(store.create("maxim", { ...baseTask, id: "earlier-id" })).resolves.toMatchObject({ outcome: "created" });
    now = "2026-07-28T10:00:00.000Z";
    await store.create("maxim", { ...baseTask, id: "newer" });

    await expect(store.get("maxim", "later-id")).resolves.toMatchObject({ id: "later-id", userId: "maxim" });
    await expect(store.get("other", "later-id")).resolves.toBeNull();
    await expect(store.list("maxim")).resolves.toMatchObject([
      { id: "earlier-id" },
      { id: "later-id" },
      { id: "newer" },
    ]);
  });

  it("isolates owners and filters by status, project, type and due date", async () => {
    const store = createInMemoryTaskStore({ now: () => "2026-07-28T09:00:00.000Z" });
    await store.create("maxim", { ...baseTask, id: "open", dueDate: "2026-07-29" });
    await store.create("maxim", { ...baseTask, id: "active", status: "in_progress", dueDate: "2026-07-30" });
    await store.create("maxim", { ...baseTask, id: "done", project: "БНВ", type: "content", status: "done" });
    await store.create("other", { ...baseTask, id: "other", status: "open", dueDate: "2026-07-28" });

    await expect(store.list("maxim", { status: ["open", "in_progress"], project: "АССИСТЕНТ", type: "operations", dueBefore: "2026-07-29" })).resolves.toMatchObject([
      { id: "open" },
    ]);
    await expect(store.list("other", { status: "open" })).resolves.toMatchObject([{ id: "other", userId: "other" }]);
  });

  it("keeps originIdeaId as task provenance and makes repeated create idempotent", async () => {
    const store = createInMemoryTaskStore({ now: () => "2026-07-28T09:00:00.000Z" });
    const input = { ...baseTask, originIdeaId: "idea-1" };

    await expect(store.create("maxim", input)).resolves.toMatchObject({ outcome: "created", task: { originIdeaId: "idea-1" } });
    await expect(store.create("maxim", input)).resolves.toMatchObject({ outcome: "unchanged", task: { revision: 1 } });
    await expect(store.create("maxim", { ...input, id: "task-2" })).resolves.toMatchObject({
      outcome: "conflict",
      current: { id: "task-1", originIdeaId: "idea-1" },
    });
    await expect(store.list("maxim")).resolves.toHaveLength(1);
  });

  it("uses optimistic revisions, reports stale conflicts and treats no-op retries as unchanged", async () => {
    let now = "2026-07-28T09:00:00.000Z";
    const store = createInMemoryTaskStore({ now: () => now });
    await store.create("maxim", baseTask);
    now = "2026-07-28T10:00:00.000Z";

    await expect(store.update("maxim", "task-1", { expectedRevision: 1, patch: { status: "in_progress" } })).resolves.toMatchObject({
      outcome: "updated",
      task: { status: "in_progress", revision: 2, updatedAt: now },
    });
    await expect(store.update("maxim", "task-1", { expectedRevision: 1, patch: { status: "done" } })).resolves.toMatchObject({
      outcome: "conflict",
      current: { status: "in_progress", revision: 2 },
    });
    await expect(store.update("maxim", "task-1", { expectedRevision: 2, patch: { status: "in_progress" } })).resolves.toMatchObject({
      outcome: "unchanged",
      task: { revision: 2 },
    });
    await expect(store.update("maxim", "task-1", { expectedRevision: 2, patch: { dueDate: "2026-07-30" } })).resolves.toMatchObject({
      outcome: "updated",
      task: { dueDate: "2026-07-30", revision: 3 },
    });
    await expect(store.update("maxim", "task-1", { expectedRevision: 3, patch: { dueDate: null } })).resolves.toMatchObject({
      outcome: "updated",
      task: { revision: 4 },
    });
    await expect(store.get("maxim", "task-1")).resolves.not.toHaveProperty("dueDate");
    await expect(store.update("other", "task-1", { expectedRevision: 4, patch: { status: "done" } })).resolves.toEqual({ outcome: "not_found" });
  });

  it("does not leak another owner's task when a globally stable id conflicts", async () => {
    const store = createInMemoryTaskStore({ now: () => "2026-07-28T09:00:00.000Z" });
    await store.create("maxim", baseTask);

    await expect(store.create("other", { ...baseTask, title: "Чужой payload" })).resolves.toEqual({ outcome: "conflict" });
    await expect(store.get("other", "task-1")).resolves.toBeNull();
  });
});
