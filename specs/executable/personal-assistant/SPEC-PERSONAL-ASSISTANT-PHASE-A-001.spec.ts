import { describe, expect, it } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";

describe("SPEC-PERSONAL-ASSISTANT-PHASE-A-001: owner-scoped personal vault", () => {
  it("writes onboarding context through the application boundary and supplies a bounded private projection", async () => {
    const world = createInMemoryWorld(() => "2026-07-15T09:00:00.000Z");
    const documents = createInMemoryDocumentStore({ now: world.now });
    const blobs = createInMemoryBlobStore({ now: world.now });
    const ideas = createInMemoryIdeaStore({ now: world.now });
    const ingestion = createIngestionService({ documentStore: documents, blobStore: blobs, ideaStore: ideas });
    await ingestion.saveContextDocument({
      userId: "maxim",
      path: "context/01_личная_конституция.md",
      content: "# Конституция\nЦенность: ясность. Стиль: коротко.",
    });
    await ingestion.saveContextDocument({
      userId: "other-owner",
      path: "context/private.md",
      content: "чужой секрет",
    });
    await ingestion.captureIdea({
      id: "idea-1",
      userId: "maxim",
      project: "АССИСТЕНТ",
      type: "development",
      summary: "Проверить порядок records projection",
      source: { kind: "text", text: "test fixture" },
      suggestedNextStep: "Проверить snapshot.",
      needsProjectClarification: false,
    });

    let receivedContext = "";
    const service = new AssistantService(
      async (_input, context) => {
        receivedContext = context.systemContext;
        return "Контекст учтён.";
      },
      { documentStore: documents, conversationStore: createInMemoryConversationStore(world), ingestionService: ingestion, ideaStore: ideas, requestIntegrityGuard: async () => ({ status: "allowed" }), clock: { now: world.now } },
    );
    const result = await service.chat({ userId: "maxim", threadId: "telegram:1", text: "Составь план дня" });

    expect(result.personalContextDocuments).toEqual(["/proc/context/01_личная_конституция.md"]);
    expect(receivedContext).toContain("Ценность: ясность");
    expect(receivedContext).not.toContain("чужой секрет");
    expect(receivedContext).toContain('path="/proc/context/01_личная_конституция.md"');
    expect(receivedContext).toContain("user-owned reference data");
    expect(receivedContext.indexOf("Personal Assistant runtime instructions")).toBeLessThan(receivedContext.indexOf("Runtime projection: /proc/context"));
    expect(receivedContext.indexOf("Runtime projection: /proc/context")).toBeLessThan(receivedContext.indexOf("Runtime projection: /proc/records"));
    expect(receivedContext).not.toContain("# RFC:");
    expect(receivedContext).not.toContain("docs/architecture/rfc-personal-assistant-architecture.md");
    expect(receivedContext).not.toContain("vault/user/knowledge_base");
    expect(receivedContext).not.toContain("## Runtime projection: /run/actions");
    expect(world.messages).toHaveLength(1);
  });

  it("routes onboarding writes through ingestion and rejects invalid owner scope", async () => {
    const world = createInMemoryWorld();
    const documents = createInMemoryDocumentStore({ now: world.now });
    const ingestion = createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore({ now: world.now }) });
    const service = new AssistantService(async () => "unused", {
      documentStore: documents,
      conversationStore: createInMemoryConversationStore(world),
      ingestionService: ingestion,
      requestIntegrityGuard: async () => ({ status: "allowed" }),
    });
    await expect(service.saveOnboardingContext({ userId: "maxim", path: "context/onboarding.md", content: "reviewed" })).resolves.toMatchObject({ path: "context/onboarding.md" });
    await expect(service.saveOnboardingContext({ userId: "maxim\u0000other", path: "context/onboarding.md", content: "reviewed" })).rejects.toThrow("invalid userId");
    await expect(service.saveOnboardingContext({ userId: ".", path: "context/onboarding.md", content: "reviewed" })).rejects.toThrow("invalid userId");
  });

  it("keeps path priority when the context-character budget is reached", async () => {
    const world = createInMemoryWorld();
    const documents = createInMemoryDocumentStore({ now: world.now });
    const ingestion = createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore({ now: world.now }) });
    for (let index = 1; index <= 4; index++) await ingestion.saveContextDocument({ userId: "maxim", path: `context/0${index}_priority.md`, content: "p".repeat(4_000) });
    await ingestion.saveContextDocument({ userId: "maxim", path: "context/05_over_budget.md", content: "o".repeat(4_000) });
    await ingestion.saveContextDocument({ userId: "maxim", path: "context/06_later.md", content: "would have fit" });
    const service = new AssistantService(async () => "unused", {
      documentStore: documents,
      conversationStore: createInMemoryConversationStore(world),
      ingestionService: ingestion,
      requestIntegrityGuard: async () => ({ status: "allowed" }),
    });
    // The first overflowing path stops the ordered projection; it may not be
    // skipped in favour of a smaller, lower-priority document.
    const result = await service.chat({ userId: "maxim", threadId: "thread", text: "context" });
    expect(result.personalContextDocuments).toEqual([
      "/proc/context/01_priority.md", "/proc/context/02_priority.md", "/proc/context/03_priority.md", "/proc/context/04_priority.md",
    ]);
  });

  it("rejects path traversal and enforces inbox-only binary ingestion", async () => {
    const world = createInMemoryWorld();
    const ingestion = createIngestionService({
      documentStore: createInMemoryDocumentStore({ now: world.now }),
      blobStore: createInMemoryBlobStore({ now: world.now }),
    });
    await expect(ingestion.saveContextDocument({ userId: "maxim", path: "context/../other.md", content: "x" })).rejects.toThrow("invalid vault path");
    await expect(ingestion.uploadInboxBlob({ userId: "maxim", key: "artifacts/file.txt", body: Buffer.from("x"), contentType: "text/plain" })).rejects.toThrow("inbox blob key");
    await expect(ingestion.uploadInboxBlob({ userId: "maxim", key: "inbox/2026-07-15/note.txt", body: Buffer.from("x"), contentType: "text/plain" })).resolves.toMatchObject({ key: "inbox/2026-07-15/note.txt", size: 1 });
  });
});
