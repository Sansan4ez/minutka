import { describe, expect, it } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
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
  const documents = createInMemoryDocumentStore(clock);
  const ingestion = createIngestionService({
    documentStore: documents,
    blobStore: createInMemoryBlobStore(clock),
    ideaStore: ideas,
  });
  const world = createInMemoryWorld(clock.now);
  const service = new AssistantService(runner, {
    documentStore: documents,
    conversationStore: createInMemoryConversationStore(world),
    ingestionService: ingestion,
    ideaStore: ideas,
    auditEventStore: createInMemoryAuditEventStore(world),
    clock,
    idGenerator: {
      requestId: () => "req-1", messageId: () => "msg-1", insightId: () => "ins-1", feedbackId: () => "fb-1", ideaId: () => "idea-1", auditEventId: () => "evt-1",
    },
  });
  return { service, ideas, world, setNow: (value: string) => { now = value; } };
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
      });
      return captured.response;
    });

    await expect(service.chat({ userId: "maxim", threadId: "telegram:1", text: "Добавь банк идей" })).resolves.toMatchObject({
      response: "Сохранил идею: Добавить IdeaStore. Следующий шаг: Создать порт хранения.",
    });
    await expect(ideas.list("maxim")).resolves.toMatchObject([{ project: "АССИСТЕНТ", type: "development", summary: "Добавить IdeaStore", source: { kind: "text", text: "Добавь банк идей" } }]);
  });

  it("binds source provenance in the application and writes a content-free audit event", async () => {
    const { service, ideas, world } = createService(async (_input, context) => {
      expect(context.systemContext).toContain("Personal Assistant process index");
      const captured = await context.captureIdea({
        project: "АССИСТЕНТ",
        type: "development",
        summary: "Фото идеи",
        suggestedNextStep: "Разобрать фото.",
        needsProjectClarification: false,
      });
      return captured.response;
    });

    await service.chat({ userId: "maxim", threadId: "telegram:1", text: "Фото идеи", source: { kind: "blob", blobKey: "inbox/photo.jpg" } });
    await expect(ideas.list("maxim")).resolves.toMatchObject([{ source: { kind: "blob", blobKey: "inbox/photo.jpg" } }]);
    expect(world.auditEvents).toMatchObject([{
      type: "idea_captured",
      employeeId: "maxim",
      metadata: { ideaId: "idea-1", project: "АССИСТЕНТ", recordType: "development", sourceKind: "blob" },
    }]);
    expect(JSON.stringify(world.auditEvents)).not.toContain("Фото идеи");
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

  it("does not override a successful agent decision that the text is not a capture", async () => {
    const { service, ideas } = createService(async () => "Принял.");

    await expect(service.chat({ userId: "maxim", threadId: "telegram:1", text: "Как дела?" })).resolves.toMatchObject({
      response: "Принял.", selectedProcessIds: ["core"],
    });
    await expect(ideas.list("maxim")).resolves.toEqual([]);
  });

  it("durably captures the input when the agent provider fails", async () => {
    const { service, ideas } = createService(async () => { throw new Error("provider unavailable"); });

    await expect(service.chat({ userId: "maxim", threadId: "telegram:1", text: "Сохрани даже при сбое" })).resolves.toMatchObject({
      response: expect.stringContaining("К какому проекту её отнести?"), selectedProcessIds: ["core", "inbox_capture"],
    });
    await expect(ideas.list("maxim")).resolves.toMatchObject([{ project: "БЕЗ_ПРОЕКТА", summary: "Сохрани даже при сбое" }]);
  });

  it("does not fail or duplicate a durable idea when the audit store is unavailable", async () => {
    const clock = { now: () => "2026-07-15T09:00:00.000Z" };
    const documents = createInMemoryDocumentStore(clock);
    const ideas = createInMemoryIdeaStore(clock);
    const ingestion = createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock), ideaStore: ideas });
    const service = new AssistantService(async (_input, context) => (await context.captureIdea({
      project: "АССИСТЕНТ", type: "development", summary: "Одна запись", suggestedNextStep: "Продолжить.", needsProjectClarification: false,
    })).response, {
      documentStore: documents,
      conversationStore: createInMemoryConversationStore(createInMemoryWorld(clock.now)),
      ingestionService: ingestion,
      ideaStore: ideas,
      auditEventStore: { async append() { throw new Error("audit unavailable"); }, async listCurrent() { return []; }, async listRecent() { return []; } },
      clock,
    });

    await expect(service.chat({ userId: "maxim", threadId: "telegram:1", text: "Запиши" })).resolves.toMatchObject({ response: expect.stringContaining("Одна запись") });
    await expect(ideas.list("maxim")).resolves.toHaveLength(1);
  });
});
