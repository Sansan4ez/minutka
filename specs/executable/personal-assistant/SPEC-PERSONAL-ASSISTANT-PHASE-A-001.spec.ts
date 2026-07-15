import { describe, expect, it } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";

describe("SPEC-PERSONAL-ASSISTANT-PHASE-A-001: owner-scoped personal vault", () => {
  it("writes onboarding context through the application boundary and supplies a bounded private projection", async () => {
    const world = createInMemoryWorld(() => "2026-07-15T09:00:00.000Z");
    const documents = createInMemoryDocumentStore({ now: world.now });
    const blobs = createInMemoryBlobStore({ now: world.now });
    const ingestion = createIngestionService({ documentStore: documents, blobStore: blobs });
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

    let receivedContext = "";
    const service = new AssistantService(
      async (_input, context) => {
        receivedContext = context.systemContext;
        return "Контекст учтён.";
      },
      { documentStore: documents, conversationStore: createInMemoryConversationStore(world), clock: { now: world.now } },
    );
    const result = await service.chat({ userId: "maxim", threadId: "telegram:1", text: "Составь план дня" });

    expect(result.personalContextDocuments).toEqual(["context/01_личная_конституция.md"]);
    expect(receivedContext).toContain("Ценность: ясность");
    expect(receivedContext).not.toContain("чужой секрет");
    expect(receivedContext).toContain("user-owned reference data");
    expect(world.messages).toHaveLength(1);
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
