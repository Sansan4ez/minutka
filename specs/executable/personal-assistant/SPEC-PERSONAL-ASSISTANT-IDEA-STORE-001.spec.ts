import { describe, expect, it } from "vitest";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";

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

  it("keeps captureInboxFile callable as a destructured application use-case", async () => {
    const clock = { now: () => "2026-07-15T09:00:00.000Z" };
    const ingestion = createIngestionService({ documentStore: createInMemoryDocumentStore(clock), blobStore: createInMemoryBlobStore(clock) });
    const { captureInboxFile } = ingestion;
    await expect(captureInboxFile({ userId: "maxim", fileName: "idea.jpg", body: Buffer.from("photo"), contentType: "image/jpeg" })).resolves.toMatchObject({ userId: "maxim", key: expect.stringMatching(/^inbox\//) });
  });

  it("matches PostgreSQL global idea-id uniqueness", async () => {
    const store = createInMemoryIdeaStore({ now: () => "2026-07-15T09:00:00.000Z" });
    await store.add({ id: "shared", userId: "maxim", project: "АССИСТЕНТ", type: "development", summary: "Первый", status: "raw" });
    await expect(store.add({ id: "shared", userId: "other", project: "БНВ", type: "content", summary: "Второй", status: "raw" })).rejects.toThrow("idea id already exists");
  });

  it("rejects blank persisted fields and ignores explicit undefined patch values", async () => {
    const store = createInMemoryIdeaStore({ now: () => "2026-07-15T09:00:00.000Z" });
    await expect(store.add({ id: "blank-project", userId: "maxim", project: " ", type: "development", summary: "valid", status: "raw" })).rejects.toThrow("project is required");
    await expect(store.add({ id: "blank-summary", userId: "maxim", project: "АССИСТЕНТ", type: "development", summary: " ", status: "raw" })).rejects.toThrow("summary is required");
    await store.add({ id: "idea-1", userId: "maxim", project: "АССИСТЕНТ", type: "development", summary: "Черновик", source: { kind: "text", text: "source" }, status: "raw" });
    await expect(store.update("maxim", "idea-1", { source: undefined, summary: undefined })).resolves.toMatchObject({ summary: "Черновик", source: { kind: "text", text: "source" } });
    await expect(store.update("maxim", "idea-1", { summary: "" })).rejects.toThrow("summary is required");
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
