import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { createPersonalAssistantTelegramShell } from "../../../src/telegram/personal-assistant-shell.js";

function setup() {
  const clock = { now: () => "2026-07-15T09:00:00.000Z" };
  const ideas = createInMemoryIdeaStore(clock);
  const blobs = createInMemoryBlobStore(clock);
  const ingestion = createIngestionService({ documentStore: createInMemoryDocumentStore(clock), blobStore: blobs, ideaStore: ideas });
  const assistant = new AssistantService(async (_input, context) => {
    const result = await context.captureIdea({ project: "БЕЗ_ПРОЕКТА", type: "knowledge", summary: "Сохранено", suggestedNextStep: "Разобрать.", needsProjectClarification: true });
    return result.response;
  }, {
    documentStore: createInMemoryDocumentStore(clock),
    conversationStore: createInMemoryConversationStore(createInMemoryWorld(clock.now)),
    ingestionService: ingestion,
    ideaStore: ideas,
    clock,
    idGenerator: { requestId: () => "req", messageId: () => "msg", insightId: () => "ins", feedbackId: () => "fb", ideaId: (() => { let id = 0; return () => `idea-${++id}`; })(), auditEventId: () => "evt" },
  });
  const replies: string[] = [];
  const shell = createPersonalAssistantTelegramShell({ assistant, ingestion, replyPort: { async sendMessage(_chatId, text) { replies.push(text); } }, speechToText: { async transcribe() { return "Голосовая мысль"; } } });
  return { shell, ideas, blobs, replies };
}

describe("SPEC-PERSONAL-ASSISTANT-TELEGRAM-001: inbox channel normalization", () => {
  it("captures text, link, voice, and photo as owner-scoped ideas with the correct source", async () => {
    const { shell, ideas, blobs, replies } = setup();
    await shell.handleText({ chatId: "1", userId: "maxim", text: "Текстовая мысль" });
    await shell.handleLink({ chatId: "1", userId: "maxim", url: "https://example.test/idea" });
    await shell.handleVoice({ chatId: "1", userId: "maxim", audio: Readable.from("voice"), filetype: "audio/ogg" });
    await shell.handlePhoto({ chatId: "1", userId: "maxim", fileName: "idea photo.jpg", body: Buffer.from("photo"), contentType: "image/jpeg", caption: "Фото идеи" });

    const stored = await ideas.list("maxim");
    expect(stored).toHaveLength(4);
    expect(stored.map((idea) => idea.source)).toEqual([
      { kind: "text", text: "Текстовая мысль" },
      { kind: "text", text: "https://example.test/idea" },
      { kind: "text", text: "Голосовая мысль" },
      expect.objectContaining({ kind: "blob", blobKey: expect.stringMatching(/^inbox\//) }),
    ]);
    const photoSource = stored[3]?.source;
    expect(photoSource?.kind).toBe("blob");
    if (photoSource?.kind === "blob") expect(await blobs.get("maxim", photoSource.blobKey)).toMatchObject({ blob: { contentType: "image/jpeg", size: 5 } });
    expect(replies).toHaveLength(4);
  });
});
