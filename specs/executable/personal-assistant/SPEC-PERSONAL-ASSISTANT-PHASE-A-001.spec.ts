import { describe, expect, it } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { createContextBudgetConfig } from "../../../src/application/context-budget.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";
import { createInMemoryTaskStore } from "../../../src/application/in-memory-task-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createInMemoryProfileStore } from "../../../src/application/in-memory-profile-store.js";
import { createInMemoryInsightStore } from "../../../src/application/in-memory-insight-store.js";
import { createInMemoryFeedbackStore } from "../../../src/application/in-memory-feedback-store.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createRuntimeProjectionBuilder } from "../../../src/application/runtime-projections/runtime-projection-builder.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";

describe("SPEC-PERSONAL-ASSISTANT-PHASE-A-001: owner-scoped personal vault", () => {
  it("writes onboarding context through the application boundary and supplies a bounded private projection", async () => {
    const world = createInMemoryWorld(() => "2026-07-15T09:00:00.000Z");
    const documents = createInMemoryDocumentStore({ now: world.now });
    const blobs = createInMemoryBlobStore({ now: world.now });
    const ideas = createInMemoryIdeaStore({ now: world.now });
    const tasks = createInMemoryTaskStore({ now: world.now });
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
    await tasks.create("maxim", {
      id: "task-1", project: "АССИСТЕНТ", type: "operations", title: "Подготовить план дня", status: "open", dueDate: "2026-07-14",
    });

    let receivedContext = "";
    const service = new AssistantService(
      async (_input, context) => {
        receivedContext = context.systemContext;
        return "Контекст учтён.";
      },
      { documentStore: documents, conversationStore: createInMemoryConversationStore(world), ingestionService: ingestion, ideaStore: ideas, taskStore: tasks, requestIntegrityGuard: async () => ({ status: "allowed" }), clock: { now: world.now } },
    );
    const result = await service.chat({ userId: "maxim", threadId: "telegram:1", text: "Составь план дня" });

    expect(result.personalContextDocuments).toEqual(["/proc/context/01_личная_конституция.md"]);
    expect(receivedContext).toContain("Ценность: ясность");
    expect(receivedContext).not.toContain("чужой секрет");
    expect(receivedContext).toContain('path="/proc/context/01_личная_конституция.md"');
    expect(receivedContext).toContain("user-owned reference data");
    expect(receivedContext).toContain('relevance="overdue"');
    expect(receivedContext).toContain("Подготовить план дня");
    expect(receivedContext).toContain("Проверить порядок records projection");
    expect(receivedContext.indexOf("Personal Assistant runtime instructions")).toBeLessThan(receivedContext.indexOf("Runtime projection: /proc/context"));
    expect(receivedContext.indexOf("Runtime projection: /proc/context")).toBeLessThan(receivedContext.indexOf("Runtime projection: /proc/records"));
    expect(receivedContext).not.toContain("# RFC:");
    expect(receivedContext).not.toContain("docs/architecture/rfc-personal-assistant-architecture.md");
    expect(receivedContext).not.toContain("vault/user/knowledge_base");
    expect(receivedContext).not.toContain("## Runtime projection: /run/current");
    expect(receivedContext).not.toContain("## Runtime projection: /run/recent");
    expect(world.messages).toHaveLength(1);
  });

  it("ranks due dates by the loaded owner profile timezone", async () => {
    const world = createInMemoryWorld(() => "2026-07-28T23:30:00.000Z");
    const profiles = createInMemoryProfileStore(world);
    const conversations = createInMemoryConversationStore(world);
    const documents = createInMemoryDocumentStore({ now: world.now });
    const tasks = createInMemoryTaskStore({ now: world.now });
    const ingestion = createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore({ now: world.now }) });
    await profiles.issueInvite({ employeeId: "maxim", inviteCode: "invite", issuedAt: world.now() });
    await profiles.completeProfile({ completedAt: world.now(), profile: {
      employeeId: "maxim", preferredName: "Максим", assistantName: "Генри", addressForm: "informal",
      persona: "efficiency", responseLength: "short", timezone: "Asia/Moscow", createdAt: world.now(), updatedAt: world.now(),
    } });
    await tasks.create("maxim", { id: "task-local", project: "PLAN", type: "operations", title: "Закрыть вчерашнюю задачу", status: "open", dueDate: "2026-07-28" });
    const chatProjectionBuilder = createRuntimeProjectionBuilder({
      profileStore: profiles, conversationStore: conversations, insightStore: createInMemoryInsightStore(world),
      feedbackStore: createInMemoryFeedbackStore(world), auditEventStore: createInMemoryAuditEventStore(world), clock: { now: world.now },
    });
    let receivedRelevance = "";
    const service = new AssistantService(async (_input, context) => {
      receivedRelevance = context.records.data.tasks[0]?.relevance ?? "";
      return "ok";
    }, {
      documentStore: documents, conversationStore: conversations, ingestionService: ingestion, taskStore: tasks,
      participantStore: profiles, chatProjectionBuilder, requestIntegrityGuard: async () => ({ status: "allowed" }), clock: { now: world.now },
    });

    await service.chat({ userId: "maxim", threadId: "thread", text: "Что просрочено?" });

    expect(receivedRelevance).toBe("overdue");
  });

  it("falls back to UTC when no profile exists", async () => {
    const world = createInMemoryWorld(() => "2026-07-28T23:30:00.000Z");
    const documents = createInMemoryDocumentStore({ now: world.now });
    const tasks = createInMemoryTaskStore({ now: world.now });
    const ingestion = createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore({ now: world.now }) });
    await tasks.create("maxim", { id: "task-utc", project: "PLAN", type: "operations", title: "Сегодня по UTC", status: "open", dueDate: "2026-07-28" });
    let receivedRelevance = "";
    const service = new AssistantService(async (_input, context) => {
      receivedRelevance = context.records.data.tasks[0]?.relevance ?? "";
      return "ok";
    }, {
      documentStore: documents, conversationStore: createInMemoryConversationStore(world), ingestionService: ingestion, taskStore: tasks,
      requestIntegrityGuard: async () => ({ status: "allowed" }), clock: { now: world.now },
    });

    await service.chat({ userId: "maxim", threadId: "thread", text: "Что на сегодня?" });

    expect(receivedRelevance).toBe("due_soon");
  });

  it("includes allow-listed profile fields and bounded owner/thread history after onboarding", async () => {
    const world = createInMemoryWorld(() => "2026-07-15T09:00:00.000Z");
    const profiles = createInMemoryProfileStore(world);
    const conversations = createInMemoryConversationStore(world);
    const documents = createInMemoryDocumentStore({ now: world.now });
    const ingestion = createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore({ now: world.now }) });
    await profiles.issueInvite({ employeeId: "maxim", inviteCode: "invite", issuedAt: world.now() });
    await ingestion.saveContextDocument({ userId: "maxim", path: "context/10_user_memory/01_личная_конституция.md", content: "CORE_CONTEXT" });
    await profiles.completeProfile({
      completedAt: world.now(),
      profile: {
        employeeId: "maxim", preferredName: "Максим", assistantName: "Генри", addressForm: "informal",
        persona: "efficiency", responseLength: "short", timezone: "Europe/Moscow",
        role: "Руководитель", typicalTasks: ["планирование"], aiLevel: "advanced", preferredCheckinsPerDay: 2,
        createdAt: world.now(), updatedAt: world.now(),
      },
    });
    await conversations.appendTurn({ messageId: "old", employeeId: "maxim", threadId: "telegram:1", userText: "Обсудим проект Альфа", agentResponse: "Да, зафиксировал контекст.", timestamp: world.now() });
    await conversations.appendTurn({ messageId: "other-thread", employeeId: "maxim", threadId: "telegram:2", userText: "OTHER_THREAD_SECRET", agentResponse: "secret", timestamp: world.now() });
    await conversations.appendTurn({ messageId: "other-owner", employeeId: "other", threadId: "telegram:1", userText: "OTHER_OWNER_SECRET", agentResponse: "secret", timestamp: world.now() });
    let receivedContext = "";
    const chatProjectionBuilder = createRuntimeProjectionBuilder({
      profileStore: profiles, conversationStore: conversations, insightStore: createInMemoryInsightStore(world),
      feedbackStore: createInMemoryFeedbackStore(world), auditEventStore: createInMemoryAuditEventStore(world), clock: { now: world.now },
    });
    const service = new AssistantService(async (_input, context) => { receivedContext = context.systemContext; return "Продолжаем Альфу."; }, {
      documentStore: documents, conversationStore: conversations, ingestionService: ingestion,
      participantStore: profiles, chatProjectionBuilder, requestIntegrityGuard: async () => ({ status: "allowed" }), clock: { now: world.now },
    });

    await service.chat({ userId: "maxim", threadId: "telegram:1", text: "Что дальше?" });

    expect(receivedContext).toContain("## Runtime projection: /proc/profile");
    expect(receivedContext).toContain("Обращение к владельцу: Максим");
    expect(receivedContext).toContain("Имя ассистента: Генри");
    expect(receivedContext).toContain("Предпочтительная длина ответа: short");
    expect(receivedContext).toContain("## Runtime projection: /proc/thread");
    expect(receivedContext).toContain("Обсудим проект Альфа");
    expect(receivedContext).not.toContain("OTHER_THREAD_SECRET");
    expect(receivedContext).not.toContain("OTHER_OWNER_SECRET");
    expect(receivedContext).not.toContain("employeeId");
    expect(receivedContext.indexOf("Runtime projection: /proc/profile")).toBeLessThan(receivedContext.indexOf("Runtime projection: /proc/context"));
  });

  it("rebuilds recent history from the canonical store after a service restart", async () => {
    const world = createInMemoryWorld();
    const profiles = createInMemoryProfileStore(world);
    const conversations = createInMemoryConversationStore(world);
    const documents = createInMemoryDocumentStore({ now: world.now });
    const ingestion = createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore({ now: world.now }) });
    await profiles.issueInvite({ employeeId: "maxim", inviteCode: "invite", issuedAt: world.now() });
    await profiles.completeProfile({ completedAt: world.now(), profile: { employeeId: "maxim", preferredName: "Максим", assistantName: "Генри", addressForm: "informal", persona: "efficiency", responseLength: "short", timezone: "Europe/Moscow", createdAt: world.now(), updatedAt: world.now() } });
    const buildProjection = () => createRuntimeProjectionBuilder({
      profileStore: profiles, conversationStore: conversations, insightStore: createInMemoryInsightStore(world),
      feedbackStore: createInMemoryFeedbackStore(world), auditEventStore: createInMemoryAuditEventStore(world), clock: { now: world.now },
    });
    const firstService = new AssistantService(async () => "Сохранил контекст перезапуска.", {
      documentStore: documents, conversationStore: conversations, ingestionService: ingestion,
      participantStore: profiles, chatProjectionBuilder: buildProjection(), requestIntegrityGuard: async () => ({ status: "allowed" }), clock: { now: world.now },
    });
    await firstService.chat({ userId: "maxim", threadId: "thread", text: "Запомни контекст перезапуска" });
    let receivedContext = "";
    const restartedService = new AssistantService(async (_input, context) => { receivedContext = context.systemContext; return "Вижу предыдущий ход."; }, {
      documentStore: documents, conversationStore: conversations, ingestionService: ingestion,
      participantStore: profiles, chatProjectionBuilder: buildProjection(), requestIntegrityGuard: async () => ({ status: "allowed" }), clock: { now: world.now },
    });

    await restartedService.chat({ userId: "maxim", threadId: "thread", text: "Что я просил запомнить?" });

    expect(receivedContext).toContain("Запомни контекст перезапуска");
    expect(receivedContext).toContain("Сохранил контекст перезапуска.");
  });

  it("marks count and content truncation in recent history", async () => {
    const world = createInMemoryWorld();
    const profiles = createInMemoryProfileStore(world);
    const conversations = createInMemoryConversationStore(world);
    const documents = createInMemoryDocumentStore({ now: world.now });
    const ingestion = createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore({ now: world.now }) });
    await profiles.issueInvite({ employeeId: "maxim", inviteCode: "invite", issuedAt: world.now() });
    await profiles.completeProfile({ completedAt: world.now(), profile: { employeeId: "maxim", preferredName: "Максим", assistantName: "Генри", addressForm: "informal", persona: "efficiency", responseLength: "short", timezone: "Europe/Moscow", createdAt: world.now(), updatedAt: world.now() } });
    for (let index = 0; index < 11; index++) await conversations.appendTurn({ messageId: `msg-${index}`, employeeId: "maxim", threadId: "thread", userText: index === 10 ? "x".repeat(7_000) : `turn-${index}`, agentResponse: `reply-${index}`, timestamp: world.now() });
    let receivedContext = "";
    const chatProjectionBuilder = createRuntimeProjectionBuilder({
      profileStore: profiles, conversationStore: conversations, insightStore: createInMemoryInsightStore(world),
      feedbackStore: createInMemoryFeedbackStore(world), auditEventStore: createInMemoryAuditEventStore(world), clock: { now: world.now },
    });
    const service = new AssistantService(async (_input, context) => { receivedContext = context.systemContext; return "ok"; }, {
      documentStore: documents, conversationStore: conversations, ingestionService: ingestion,
      participantStore: profiles, chatProjectionBuilder, requestIntegrityGuard: async () => ({ status: "allowed" }), clock: { now: world.now },
    });

    await service.chat({ userId: "maxim", threadId: "thread", text: "continue" });

    expect(receivedContext).not.toContain("turn-0");
    expect(receivedContext).toContain("Some earlier conversation turns or turn contents were omitted by the history limit.");
    expect(receivedContext).not.toContain("x".repeat(6_001));
  });

  it("prioritizes semantic core documents ahead of large inbox and transcription files", async () => {
    const world = createInMemoryWorld();
    const documents = createInMemoryDocumentStore({ now: world.now });
    const ingestion = createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore({ now: world.now }) });
    for (let index = 0; index < 12; index++) await ingestion.saveContextDocument({ userId: "maxim", path: `context/00_inbox/transcriptions/${String(index).padStart(2, "0")}.md`, content: "inbox" });
    await ingestion.saveContextDocument({ userId: "maxim", path: "context/10_user_memory/01_Persona.md", content: "CORE_PERSONA" });
    await ingestion.saveContextDocument({ userId: "maxim", path: "context/10_user_memory/02_Goals_and_priorities.md", content: "CORE_GOALS" });
    await ingestion.saveContextDocument({ userId: "maxim", path: "context/40_projects/2026_07_26_мои_проекты.md", content: "CORE_PROJECTS" });
    await ingestion.saveContextDocument({ userId: "maxim", path: "context/90_agent_memory/soul.md", content: "CORE_CHARACTER" });
    await ingestion.saveContextDocument({ userId: "maxim", path: "context/10_user_memory/06_Tags_and_Classifications.md", content: "CORE_CLASSIFIER" });
    let receivedContext = "";
    const service = new AssistantService(async (_input, context) => { receivedContext = context.systemContext; return "ok"; }, {
      documentStore: documents, conversationStore: createInMemoryConversationStore(world), ingestionService: ingestion,
      requestIntegrityGuard: async () => ({ status: "allowed" }), clock: { now: world.now },
    });

    const result = await service.chat({ userId: "maxim", threadId: "thread", text: "context" });

    expect(result.personalContextDocuments?.slice(0, 5)).toEqual([
      "/proc/context/10_user_memory/01_Persona.md",
      "/proc/context/10_user_memory/02_Goals_and_priorities.md",
      "/proc/context/40_projects/2026_07_26_мои_проекты.md",
      "/proc/context/90_agent_memory/soul.md",
      "/proc/context/10_user_memory/06_Tags_and_Classifications.md",
    ]);
    for (const marker of ["CORE_PERSONA", "CORE_GOALS", "CORE_PROJECTS", "CORE_CHARACTER", "CORE_CLASSIFIER"]) expect(receivedContext).toContain(marker);
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
      contextBudget: createContextBudgetConfig({ sources: { context: 16_000 }, projectionLimits: { contextDocumentCharacters: 8_000 } }),
    });
    // Earlier paths keep their full-content priority. Overflowing and later
    // paths use bounded index references and remain visible in the complete index.
    const result = await service.chat({ userId: "maxim", threadId: "thread", text: "context" });
    expect(result.personalContextDocuments).toEqual([
      "/proc/context/01_priority.md", "/proc/context/02_priority.md", "/proc/context/03_priority.md", "/proc/context/04_priority.md",
      "/proc/context/05_over_budget.md", "/proc/context/06_later.md",
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
