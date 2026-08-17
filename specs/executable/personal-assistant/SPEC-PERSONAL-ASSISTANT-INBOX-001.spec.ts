import { describe, expect, it } from "vitest";
import { IdeaAppendService } from "../../../src/application/idea-append.js";
import { AssistantService, missingAgentResponseUserMessage } from "../../../src/application/assistant-service.js";
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
  const auditEventStore = createInMemoryAuditEventStore(world);
  const idGenerator = {
    requestId: () => "req-1", messageId: () => "msg-1", insightId: () => "ins-1", feedbackId: () => "fb-1", ideaId: () => "idea-1", auditEventId: () => "evt-1",
  };
  const service = new AssistantService(runner, {
    documentStore: documents,
    conversationStore: createInMemoryConversationStore(world),
    ingestionService: ingestion,
    ideaStore: ideas,
    ideaAppends: new IdeaAppendService(ideas, { auditEventStore, clock, idGenerator }),
    auditEventStore,
    requestIntegrityGuard: async () => ({ status: "allowed" }),
    clock,
    idGenerator,
  });
  return { service, ideas, documents, world, setNow: (value: string) => { now = value; } };
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

  it("captures a bare URL once as chat text before asking for processing intent", async () => {
    let captureCalls = 0;
    const { service, ideas } = createService(async (_input, context) => {
      captureCalls += 1;
      const captured = await context.captureIdea({
        project: "БЕЗ_ПРОЕКТА",
        type: "knowledge",
        summary: "https://example.com",
        suggestedNextStep: "Уточнить, что сделать со ссылкой.",
        needsProjectClarification: false,
      });
      expect(captured.idea.source).toEqual({ kind: "text", text: "https://example.com" });
      return `${captured.response} Что сделать со ссылкой?`;
    });

    await expect(service.chat({ userId: "maxim", threadId: "telegram:url", text: "https://example.com" })).resolves.toMatchObject({
      response: expect.stringMatching(/^Сохранил идею: https:\/\/example\.com\..*Что сделать со ссылкой\?$/),
      selectedProcessIds: ["core", "inbox_capture"],
      effect: "business_write_committed",
    });
    expect(captureCalls).toBe(1);
    await expect(ideas.list("maxim")).resolves.toEqual([
      expect.objectContaining({
        userId: "maxim",
        summary: "https://example.com",
        source: { kind: "text", text: "https://example.com" },
      }),
    ]);
    await expect(ideas.list("other-owner")).resolves.toEqual([]);
  });

  it("keeps a URL and the owner's stated intent in one idea without claiming page access or creating documents", async () => {
    const text = "Посмотри ссылку и сравни с нашим предложением: https://example.com";
    const { service, ideas, documents } = createService(async (_input, context) => {
      const captured = await context.captureIdea({
        project: "БЕЗ_ПРОЕКТА",
        type: "knowledge",
        summary: text,
        suggestedNextStep: "Сравнить страницу с нашим предложением, когда доступен инструмент чтения ссылки.",
        needsProjectClarification: false,
      });
      return `${captured.response} Сейчас у меня нет инструмента, чтобы открыть и прочитать страницу.`;
    });
    await expect(service.chat({ userId: "maxim", threadId: "telegram:url-intent", text })).resolves.toMatchObject({
      response: expect.stringContaining("нет инструмента, чтобы открыть и прочитать страницу"),
      selectedProcessIds: ["core", "inbox_capture"],
    });
    await expect(ideas.list("maxim")).resolves.toEqual([
      expect.objectContaining({ summary: text, source: { kind: "text", text } }),
    ]);
    await expect(documents.list("maxim")).resolves.toEqual([]);
  });

  it("binds source provenance in the application and writes a content-free audit event", async () => {
    const { service, ideas, world } = createService(async (_input, context) => {
      expect(context.systemContext).toContain("«Минутка» process index");
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
    expect(world.auditEvents.map(({ type, metadata }) => ({ type, metadata }))).toEqual([
      { type: "chat_received", metadata: { inputModality: "text" } },
      { type: "idea_captured", metadata: { ideaId: "idea-1", recordType: "development", sourceKind: "blob" } },
      { type: "chat_response_generated", metadata: {} },
    ]);
    expect(JSON.stringify(world.auditEvents)).not.toContain("Фото идеи");
  });

  it("uses the capture confirmation when the agent finishes the tool step without text", async () => {
    const { service, ideas, world } = createService(async (_input, context) => {
      await context.captureIdea({
        project: "АССИСТЕНТ", type: "development", summary: "Сохранено без финального текста",
        suggestedNextStep: "Продолжить.", needsProjectClarification: false,
      });
      return "   ";
    });

    await expect(service.chat({ userId: "maxim", threadId: "telegram:1", text: "Запиши" })).resolves.toMatchObject({
      response: "Сохранил идею: Сохранено без финального текста. Следующий шаг: Продолжить.",
    });
    await expect(ideas.list("maxim")).resolves.toHaveLength(1);
    expect(world.messages[0]?.response).toContain("Сохранено без финального текста");
  });

  it("asks one plain-text choice for a visible similar idea before writing", async () => {
    const { service, ideas } = createService(async (_input, context) => {
      const [candidate] = context.records.data.records;
      expect(candidate).toMatchObject({ id: "idea-pool", summary: "Записаться в бассейн" });
      return "Похоже на запись от 09:00 про бассейн — дополнить её или завести отдельную?";
    });
    await ideas.add({ id: "idea-pool", userId: "maxim", project: "Бассейн", type: "personal", summary: "Записаться в бассейн", status: "raw" });

    await expect(service.chat({ userId: "maxim", threadId: "telegram:1", text: "По бассейну: записался, сон был спокойный" })).resolves.toMatchObject({
      response: "Похоже на запись от 09:00 про бассейн — дополнить её или завести отдельную?",
      effect: "none",
      pendingActions: [],
    });
    await expect(ideas.list("maxim")).resolves.toEqual([expect.objectContaining({ id: "idea-pool", revision: 1 })]);
  });

  it("supplements a visible similar idea instead of creating a duplicate", async () => {
    const { service, ideas, setNow } = createService(async (_input, context) => {
      const [candidate] = context.records.data.records;
      expect(candidate).toMatchObject({ id: "idea-pool", summary: "Записаться в бассейн", revision: 1 });
      const result = await context.ideas.append({
        ideaId: candidate!.id,
        expectedRevision: candidate!.revision,
        text: "Записался; после бассейна сон был спокойный",
      });
      expect(result.status).toBe("applied");
      return "Дополнил существующую запись про бассейн.";
    });
    await ideas.add({ id: "idea-pool", userId: "maxim", project: "Бассейн", type: "personal", summary: "Записаться в бассейн", status: "raw" });
    setNow("2026-07-15T09:30:00.000Z");

    await expect(service.chat({ userId: "maxim", threadId: "telegram:1", text: "По бассейну: записался, сон был спокойный" })).resolves.toMatchObject({
      response: "Дополнил существующую запись про бассейн.",
      selectedProcessIds: ["core", "inbox_capture"],
      effect: "business_write_committed",
    });
    await expect(ideas.list("maxim")).resolves.toEqual([
      expect.objectContaining({
        id: "idea-pool",
        summary: "Записаться в бассейн\n\nЗаписался; после бассейна сон был спокойный",
        revision: 2,
        lastActivityAt: "2026-07-15T09:30:00.000Z",
      }),
    ]);
  });

  it("writes one content-free audit event only when an idea append is applied", async () => {
    const appendText = "Прямой приватный текст дополнения";
    const { service, ideas, world } = createService(async (_input, context) => {
      const [idea] = context.records.data.records;
      const applied = await context.ideas.append({ ideaId: idea!.id, expectedRevision: idea!.revision, text: appendText });
      expect(applied.status).toBe("applied");
      const conflict = await context.ideas.append({ ideaId: idea!.id, expectedRevision: idea!.revision, text: "stale private text" });
      expect(conflict.status).toBe("conflict");
      const missing = await context.ideas.append({ ideaId: "missing", expectedRevision: 1, text: "missing private text" });
      expect(missing.status).toBe("not_found");
      return "Дополнил.";
    });
    await ideas.add({ id: "idea-pool", userId: "maxim", project: "Бассейн", type: "personal", summary: "Записаться в бассейн", status: "raw" });

    await service.chat({ userId: "maxim", threadId: "telegram:append-audit", text: "Дополни запись" });

    expect(world.auditEvents.filter(({ type }) => type === "idea_appended")).toEqual([
      expect.objectContaining({
        requestId: "req-1",
        employeeId: "maxim",
        threadId: "telegram:append-audit",
        messageId: "msg-1",
        metadata: { ideaId: "idea-pool", recordType: "personal" },
      }),
    ]);
    const serializedAudit = JSON.stringify(world.auditEvents);
    expect(serializedAudit).not.toContain(appendText);
    expect(serializedAudit).not.toContain("stale private text");
    expect(serializedAudit).not.toContain("missing private text");
  });

  it("does not add ceremony when visible records have no clear match", async () => {
    let sawExistingUnrelatedRecord = false;
    const { service, ideas } = createService(async (_input, context) => {
      sawExistingUnrelatedRecord = context.records.data.records.some(({ summary }) => summary.includes("бассейн"));
      return (await context.captureIdea({
        project: "РЕМОНТ", type: "operations", summary: "Купить краску",
        suggestedNextStep: "Выбрать цвет", needsProjectClarification: false,
      })).response;
    });
    await ideas.add({ id: "idea-pool", userId: "maxim", project: "Бассейн", type: "personal", summary: "Записаться в бассейн", status: "raw" });

    await expect(service.chat({ userId: "maxim", threadId: "telegram:1", text: "Запиши: купить краску" })).resolves.toMatchObject({
      response: "Сохранил идею: Купить краску. Следующий шаг: Выбрать цвет.",
    });
    expect(sawExistingUnrelatedRecord).toBe(true);
    await expect(ideas.list("maxim")).resolves.toHaveLength(2);
  });

  it("preserves the item by creating it when a duplicate choice is ambiguous", async () => {
    const { service, ideas } = createService(async (_input, context) => {
      expect(context.records.data.records).toEqual([expect.objectContaining({ id: "idea-pool" })]);
      return (await context.captureIdea({
        project: "Бассейн", type: "personal", summary: "После бассейна сон был спокойный",
        suggestedNextStep: "Наблюдать ещё неделю", needsProjectClarification: false,
      })).response;
    });
    await ideas.add({ id: "idea-pool", userId: "maxim", project: "Бассейн", type: "personal", summary: "Записаться в бассейн", status: "raw" });

    await expect(service.chat({ userId: "maxim", threadId: "telegram:1", text: "не уверен, как лучше" })).resolves.toMatchObject({
      response: expect.stringContaining("Сохранил идею"),
    });
    await expect(ideas.list("maxim")).resolves.toHaveLength(2);
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

  // «Минутка» captures an idea only when the agent asks for it. inbox_capture
  // is a disabled process here, and the employee account is already durable in
  // private conversation history, so a turn that wrote nothing is reported as
  // the failure it is rather than as a saved idea.
  it("reports a failed provider turn instead of capturing the input", async () => {
    const failure = new Error("provider unavailable");
    const { service, ideas } = createService(async () => { throw failure; });

    await expect(service.chat({ userId: "maxim", threadId: "telegram:1", text: "Сохрани даже при сбое" })).rejects.toBe(failure);
    await expect(ideas.list("maxim")).resolves.toEqual([]);
  });

  it("answers a silent turn without capturing the input", async () => {
    const { service, ideas } = createService(async () => "");

    await expect(service.chat({ userId: "maxim", threadId: "telegram:1", text: "Дополни заметку про ключ" })).resolves.toMatchObject({
      response: missingAgentResponseUserMessage, selectedProcessIds: ["core"], effect: "none",
    });
    await expect(ideas.list("maxim")).resolves.toEqual([]);
  });

  it("rejects an unknown participant before invoking the agent or persisting input", async () => {
    let agentCalls = 0;
    const clock = { now: () => "2026-07-15T09:00:00.000Z" };
    const documents = createInMemoryDocumentStore(clock);
    const ideas = createInMemoryIdeaStore(clock);
    const ingestion = createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock), ideaStore: ideas });
    const guarded = new AssistantService(async () => { agentCalls += 1; return "unused"; }, {
      documentStore: documents,
      conversationStore: createInMemoryConversationStore(createInMemoryWorld(clock.now)),
      ingestionService: ingestion,
      ideaStore: ideas,
      participantStore: { async getParticipant() { return undefined; } },
      requestIntegrityGuard: async () => ({ status: "allowed" }),
      clock,
    });
    await expect(guarded.chat({ userId: "missing", threadId: "thread", text: "не терять" })).rejects.toMatchObject({ code: "participant_not_found" });
    expect(agentCalls).toBe(0);
    await expect(ideas.list("missing")).resolves.toEqual([]);
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
      requestIntegrityGuard: async () => ({ status: "allowed" }),
      clock,
    });

    await expect(service.chat({ userId: "maxim", threadId: "telegram:1", text: "Запиши" })).resolves.toMatchObject({ response: expect.stringContaining("Одна запись") });
    await expect(ideas.list("maxim")).resolves.toHaveLength(1);
  });
});
