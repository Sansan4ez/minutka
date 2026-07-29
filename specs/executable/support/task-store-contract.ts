import { expect } from "vitest";
import type { TaskStore } from "../../../src/application/task-store.js";

export async function expectInvalidEmptyTaskPatchContract(
  store: TaskStore,
  input: { ownerId: string; taskId: string; expectedRevision: number },
): Promise<void> {
  const before = await store.get(input.ownerId, input.taskId);
  expect(before).not.toBeNull();

  await expect(store.update(input.ownerId, input.taskId, {
    expectedRevision: input.expectedRevision,
    patch: {},
  })).rejects.toThrow("Task patch must not be empty");
  await expect(store.update(input.ownerId, input.taskId, {
    expectedRevision: input.expectedRevision,
    patch: { status: undefined },
  })).rejects.toThrow("Task patch must not be empty");

  await expect(store.get(input.ownerId, input.taskId)).resolves.toEqual(before);
}
