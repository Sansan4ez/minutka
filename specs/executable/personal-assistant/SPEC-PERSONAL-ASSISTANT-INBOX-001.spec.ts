import { describe, expect, it } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";

function createService(runner: ConstructorParameters<typeof AssistantService>[0]) {
  let now = "2026-07-15T09:00:00.000Z";
  const clock = { now: () => now };
  const ideas = createInMemoryIdeaStore(clock);
  const ingestion = createIngestionService({
    documentStore: createInMemoryDocumentStore(clock),
    blobStore: createInMemoryBlobStore(clock),
    ideaStore: ideas,
  });
  const service = new AssistantService(runner, {
    documentStore: createInMemoryDocumentStore(clock),
    conversationStore: createInMemoryConversationStore(createInMemoryWorld(clock.now)),
    ingestionService: ingestion,
    clock,
    idGenerator: {
      requestId: () => "req-1", messageId: () => "msg-1", insightId: () => "ins-1", feedbackId: () => "fb-1", ideaId: () => "idea-1", auditEventId: () => "evt-1",
    },
  });
  return { service, ideas, setNow: (value: string) => { now = value; } };
}

describe("SPEC-PERSONAL-ASSISTANT-INBOX-001: classified idea capture", () => {
  it("saves the tool-classified idea and returns a summary and next step", async () => {
    const { service, ideas } = createService(async (_input, context) => {
      const captured = await context.captureIdea({
        project: "АССИСТЕНТ",
        type: "development",
        summary: "Добавить IdeaStore",
        suggestedNextStep: "Создать порт хранения.",
        needsProjectClarification: false,
        source: { kind: "text", text: "Добавь банк идей" },
      });
      return captured.response;
    });

    await expect(service.chat({ userId: "maxim", threadId: "telegram:1", text: "Добавь банк идей" })).resolves.toMatchObject({
      response: "Сохранил идею: Добавить IdeaStore. Следующий шаг: Создать порт хранения.",
    });
    await expect(ideas.list("maxim")).resolves.toMatchObject([{ project: "АССИСТЕНТ", type: "development", summary: "Добавить IdeaStore", source: { kind: "text", text: "Добавь банк идей" } }]);
  });

  it("collapses an unknown project to БЕЗ_ПРОЕКТА and asks for clarification", async () => {
    const { service, ideas } = createService(async (_input, context) => {
      const captured = await context.captureIdea({
        project: "НЕИЗВЕСТНЫЙ",
        type: "knowledge",
        summary: "Заметка",
        suggestedNextStep: "Уточнить проект.",
        needsProjectClarification: true,
      });
      return captured.response;
    });

    await expect(service.chat({ userId: "maxim", threadId: "telegram:1", text: "Заметка" })).resolves.toMatchObject({
      response: expect.stringContaining("К какому проекту её отнести?"),
    });
    await expect(ideas.list("maxim")).resolves.toMatchObject([{ project: "БЕЗ_ПРОЕКТА", type: "knowledge" }]);
  });

  it("uses the no-loss backstop if the agent does not call captureIdea", async () => {
    const { service, ideas } = createService(async () => "Принял.");

    await expect(service.chat({ userId: "maxim", threadId: "telegram:1", text: "Не потеряй эту мысль" })).resolves.toMatchObject({ response: "Принял." });
    await expect(ideas.list("maxim")).resolves.toMatchObject([{
      project: "БЕЗ_ПРОЕКТА", type: "knowledge", summary: "Не потеряй эту мысль", source: { kind: "text", text: "Не потеряй эту мысль" }, status: "raw",
    }]);
  });
});
