import { describe, expect, it } from "vitest";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";

describe("SPEC-PERSONAL-ASSISTANT-IDEA-STORE-001: owner-scoped idea bank", () => {
  it("lists only the owner's ideas and filters them by both classification axes and status", async () => {
    const store = createInMemoryIdeaStore({ now: () => "2026-07-15T09:00:00.000Z" });
    await store.add({ id: "idea-1", userId: "maxim", project: "АССИСТЕНТ", type: "development", summary: "Первый" , status: "raw" });
    await store.add({ id: "idea-2", userId: "maxim", project: "БНВ", type: "content", summary: "Второй", status: "planned" });
    await store.add({ id: "idea-3", userId: "other", project: "АССИСТЕНТ", type: "development", summary: "Чужой", status: "raw" });

    await expect(store.list("maxim", { project: "АССИСТЕНТ", type: "development", status: "raw" })).resolves.toMatchObject([
      { id: "idea-1", userId: "maxim", summary: "Первый", createdAt: "2026-07-15T09:00:00.000Z", lastActivityAt: "2026-07-15T09:00:00.000Z" },
    ]);
    await expect(store.list("other")).resolves.toMatchObject([{ id: "idea-3", userId: "other" }]);
  });

  it("returns only inactive raw or discussed ideas older than the requested number of days", async () => {
    let now = "2026-07-01T00:00:00.000Z";
    const store = createInMemoryIdeaStore({ now: () => now });
    await store.add({ id: "raw", userId: "maxim", project: "БЕЗ_ПРОЕКТА", type: "knowledge", summary: "raw", status: "raw" });
    await store.add({ id: "discussed", userId: "maxim", project: "БЕЗ_ПРОЕКТА", type: "knowledge", summary: "discussed", status: "discussed" });
    await store.add({ id: "planned", userId: "maxim", project: "БЕЗ_ПРОЕКТА", type: "knowledge", summary: "planned", status: "planned" });
    await store.add({ id: "other", userId: "other", project: "БЕЗ_ПРОЕКТА", type: "knowledge", summary: "other", status: "raw" });
    now = "2026-07-10T00:00:00.000Z";

    await expect(store.stale("maxim", 7)).resolves.toMatchObject([{ id: "discussed" }, { id: "raw" }]);
    await expect(store.stale("other", 7)).resolves.toMatchObject([{ id: "other" }]);
    await expect(store.stale("maxim", -1)).rejects.toThrow("days must be a non-negative finite number");
  });

  it("matches PostgreSQL global idea-id uniqueness", async () => {
    const store = createInMemoryIdeaStore({ now: () => "2026-07-15T09:00:00.000Z" });
    await store.add({ id: "shared", userId: "maxim", project: "АССИСТЕНТ", type: "development", summary: "Первый", status: "raw" });
    await expect(store.add({ id: "shared", userId: "other", project: "БНВ", type: "content", summary: "Второй", status: "raw" })).rejects.toThrow("idea id already exists");
  });

  it("updates an idea in its owner scope and renews its activity timestamp", async () => {
    let now = "2026-07-01T00:00:00.000Z";
    const store = createInMemoryIdeaStore({ now: () => now });
    await store.add({ id: "idea-1", userId: "maxim", project: "АССИСТЕНТ", type: "development", summary: "Черновик", status: "raw" });
    now = "2026-07-02T12:00:00.000Z";

    await expect(store.update("other", "idea-1", { status: "done" })).resolves.toBeNull();
    await expect(store.update("maxim", "idea-1", { summary: "Готово", status: "discussed" })).resolves.toMatchObject({
      id: "idea-1", summary: "Готово", status: "discussed", createdAt: "2026-07-01T00:00:00.000Z", lastActivityAt: "2026-07-02T12:00:00.000Z",
    });
  });
});
