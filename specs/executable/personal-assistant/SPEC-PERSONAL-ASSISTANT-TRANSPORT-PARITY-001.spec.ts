import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantService, type AssistantAgentContext } from "../../../src/application/assistant-service.js";
import { overflowAfterDurableWriteUserMessage, overflowRecoveryUserMessage } from "../../../src/application/assistant-overflow-recovery.js";
import { mutationOutcomeUnknownUserMessage } from "../../../src/application/assistant-mutation-outcome.js";
import { PersonalAssistantService } from "../../../src/application/personal-assistant-service.js";
import { createInMemoryArtifactContentStore } from "../../../src/application/in-memory-artifact-content-store.js";
import { createInMemoryArtifactStore } from "../../../src/application/in-memory-artifact-store.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";
import { createInMemoryTaskStore } from "../../../src/application/in-memory-task-store.js";
import { createInMemoryTaskMutationConfirmationStore } from "../../../src/application/in-memory-task-mutation-confirmation-store.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { TaskMutationConfirmationService } from "../../../src/application/task-mutation-confirmation.js";
import { IdeaDeletionService } from "../../../src/application/idea-deletion.js";
import { createInMemoryIdeaDeletionConfirmationStore } from "../../../src/application/in-memory-idea-deletion-confirmation-store.js";
import { IdeaToTaskService } from "../../../src/application/idea-to-task.js";
import { createDeterministicIdGenerator } from "../../../src/application/runtime-primitives.js";
import { EmployeeMinutkaClient, ServiceMinutkaClient } from "../../../src/client/sdk/minutka-client.js";
import { HttpEmployeeMinutkaTransport, HttpServiceMinutkaTransport } from "../../../src/client/sdk/http-transport.js";
import { createInMemoryRuntime, executableSpecPrivacyExplanation } from "../../../src/runtime/create-in-memory-runtime.js";
import { listenHttpServer, type RunningHttpServer } from "../../../src/server/http/http-server.js";
import { createTelegramShell } from "../../../src/telegram/telegram-shell.js";
import { createDefaultSpecDeps } from "../support/scripted-deps.js";

const ownerToken = "a".repeat(64);
const otherOwnerToken = "b".repeat(64);
const serviceToken = "c".repeat(64);
const running: RunningHttpServer[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
});

describe("SPEC-PERSONAL-ASSISTANT-TRANSPORT-PARITY-001: one owner-scoped assistant path", () => {
  it("routes Telegram and HTTP through one AssistantService and keeps another owner's projections and artifacts isolated", async () => {
    const clock = { now: () => "2026-07-16T09:00:00.000Z" };
    const runtime = createInMemoryRuntime({ agentRunner: async () => "legacy", deps: createDefaultSpecDeps() });
    await prepareOwner(runtime.service, "owner-a", "invite-a", { chatId: "chat-a", userId: "telegram-a" });
    await prepareOwner(runtime.service, "owner-b", "invite-b");

    const documents = createInMemoryDocumentStore(clock);
    const blobs = createInMemoryBlobStore(clock);
    const ideas = createInMemoryIdeaStore(clock);
    const ingestion = createIngestionService({ documentStore: documents, blobStore: blobs, ideaStore: ideas });
    await ingestion.saveContextDocument({ userId: "owner-a", path: "context/private.md", content: "OWNER_A_PRIVATE_CONTEXT" });
    await ingestion.captureIdea({
      id: "idea-owner-a",
      userId: "owner-a",
      project: "ASSISTANT",
      type: "development",
      summary: "OWNER_A_PRIVATE_RECORD",
      suggestedNextStep: "Continue",
      needsProjectClarification: false,
    });

    const artifactStore = createInMemoryArtifactStore({
      contentStore: createInMemoryArtifactContentStore(clock),
      clock,
      limits: { maximumBytes: 1024, timeoutMs: 1_000 },
    });
    const calls: Array<{ userId: string; text: string; context: AssistantAgentContext }> = [];
    const assistant = new AssistantService(async (input, context) => {
      calls.push({ userId: input.userId, text: input.text, context });
      return `assistant:${input.text}`;
    }, {
      documentStore: documents,
      conversationStore: createInMemoryConversationStore(runtime.world),
      ingestionService: ingestion,
      ideaStore: ideas,
      requestIntegrityGuard: async () => ({ status: "allowed" }),
      clock,
      idGenerator: createDeterministicIdGenerator(),
    });

    const facade = new PersonalAssistantService(runtime.service, assistant, artifactStore);
    const server = await listenHttpServer({
      application: facade,
      port: 0,
      logger: () => undefined,
      auth: {
        serviceToken,
        employeeTokens: new Map([
          ["owner-a", ownerToken],
          ["owner-b", otherOwnerToken],
        ]),
      },
    });
    running.push(server);

    const telegramReplies: string[] = [];
    const telegram = createTelegramShell({
      privacyExplanation: executableSpecPrivacyExplanation, client: new ServiceMinutkaClient(new HttpServiceMinutkaTransport({ baseUrl: server.url, token: serviceToken })),
      sessionStore: runtime.telegramSessionStore,
      artifactIntake: facade,
      fileGateway: {
        createFileBody: () => ({ size: 7, openStream: () => Readable.from("private") }),
      },
      replyPort: {
        async sendMessage(_chatId, text) { telegramReplies.push(text); return { messageId: telegramReplies.length }; },
        async sendChatAction() {},
        async editReplyMarkup() {}, async answerCallbackQuery() {},
      },
    });
    await telegram.handleText("chat-a", "from Telegram", "telegram-a");
    await telegram.handleFile("chat-a", {
      fileId: "private-file",
      fileUniqueId: "private-file-unique",
      messageId: 42,
      payloadKind: "document",
      fileName: "private.txt",
      declaredMediaType: "text/plain",
      fileSizeBytes: 7,
      forwarded: false,
    }, "telegram-a");

    const ownerHttp = new EmployeeMinutkaClient(new HttpEmployeeMinutkaTransport({ baseUrl: server.url, token: ownerToken }));
    const otherOwnerHttp = new EmployeeMinutkaClient(new HttpEmployeeMinutkaTransport({ baseUrl: server.url, token: otherOwnerToken }));
    await expect(ownerHttp.chat({ threadId: "http-owner-a", text: "from HTTP" })).resolves.toMatchObject({ response: "assistant:from HTTP" });
    await expect(otherOwnerHttp.chat({ threadId: "http-owner-b", text: "isolation probe" })).resolves.toMatchObject({ response: "assistant:isolation probe" });

    expect(telegramReplies).toContain("assistant:from Telegram");
    expect(telegramReplies).toContain("Файл сохранён.");
    expect(calls.map(({ userId, text }) => ({ userId, text }))).toEqual([
      { userId: "owner-a", text: "from Telegram" },
      { userId: "owner-a", text: "from HTTP" },
      { userId: "owner-b", text: "isolation probe" },
    ]);
    for (const call of calls.slice(0, 2)) {
      expect(call.context.personalContext.data.documents.map((document) => document.content)).toContain("OWNER_A_PRIVATE_CONTEXT");
      expect(call.context.records.data.records.map((record) => record.summary)).toContain("OWNER_A_PRIVATE_RECORD");
    }
    expect(calls[2]?.context.personalContext.data.documents).toEqual([]);
    expect(calls[2]?.context.records.data.records).toEqual([]);
    const [ownerArtifact] = await facade.listArtifacts("owner-a");
    expect(ownerArtifact).toMatchObject({ ownerId: "owner-a", originalFileName: "private.txt" });
    await expect(facade.getArtifact("owner-b", ownerArtifact!.artifactId)).resolves.toBeNull();
    await expect(facade.listArtifacts("owner-b")).resolves.toEqual([]);
  });

  it("uses the same owner-bound task confirmation use-case over employee HTTP and Telegram service HTTP", async () => {
    const clock = { now: () => "2026-07-28T09:00:00.000Z" };
    const runtime = createInMemoryRuntime({ agentRunner: async () => "legacy", deps: createDefaultSpecDeps() });
    await prepareOwner(runtime.service, "owner-a", "invite-task-owner", { chatId: "chat-task-owner", userId: "telegram-task-owner" });
    const documents = createInMemoryDocumentStore(clock);
    const ideas = createInMemoryIdeaStore(clock);
    const ingestion = createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock), ideaStore: ideas });
    const artifacts = createInMemoryArtifactStore({ contentStore: createInMemoryArtifactContentStore(clock), clock, limits: { maximumBytes: 1024, timeoutMs: 1_000 } });
    const tasks = createInMemoryTaskStore(clock);
    let confirmationId = 0;
    const taskMutations = new TaskMutationConfirmationService(
      createInMemoryTaskMutationConfirmationStore(tasks), clock,
      { confirmationId: () => `transport-confirmation-${++confirmationId}` },
    );
    const ideaToTask = new IdeaToTaskService(ideas, tasks, taskMutations);
    const createChat = new AssistantService(async (_input, context) => {
      await context.tasks.propose({ kind: "create", title: "HTTP task", project: "ASSISTANT", type: "operations" });
      return "ready";
    }, {
      documentStore: documents, conversationStore: createInMemoryConversationStore(runtime.world), ingestionService: ingestion,
      ideaStore: ideas, taskStore: tasks, taskMutations: { propose: taskMutations.propose.bind(taskMutations) }, ideaToTask,
      requestIntegrityGuard: async () => ({ status: "allowed" }), clock, idGenerator: createDeterministicIdGenerator(),
    });
    const taskFacade = new PersonalAssistantService(runtime.service, createChat, artifacts, taskMutations);
    const taskServer = await listenHttpServer({ application: taskFacade, port: 0, logger: () => undefined, auth: { serviceToken, employeeTokens: new Map([["owner-a", ownerToken]]) } });
    running.push(taskServer);
    const taskEmployee = new EmployeeMinutkaClient(new HttpEmployeeMinutkaTransport({ baseUrl: taskServer.url, token: ownerToken }));
    const taskTelegram = new ServiceMinutkaClient(new HttpServiceMinutkaTransport({ baseUrl: taskServer.url, token: serviceToken })).forEmployee("owner-a");

    const proposed = await taskEmployee.chat({ threadId: "http-task", text: "create" });
    if (!proposed.pendingActions[0]) throw new Error("expected pending action");
    const proposedAction = proposed.pendingActions[0];
    expect(proposedAction).toMatchObject({
      actionKind: "create",
      summary: "Создать задачу: HTTP task",
      preview: { kind: "create", title: { value: "HTTP task", truncated: false }, project: { value: "ASSISTANT", truncated: false }, type: "operations", dueDate: null },
    });
    await expect(tasks.list("owner-a")).resolves.toEqual([]);
    await expect(taskTelegram.confirmTaskMutation(proposedAction.confirmationId)).resolves.toMatchObject({ status: "confirmed", outcome: { outcome: "created" } });

    const rejected = await taskEmployee.chat({ threadId: "http-task-2", text: "create another" });
    if (!rejected.pendingActions[0]) throw new Error("expected pending action");
    const rejectedAction = rejected.pendingActions[0];
    await expect(taskEmployee.rejectTaskMutation(rejectedAction.confirmationId)).resolves.toEqual({ status: "rejected" });
    await expect(taskTelegram.confirmTaskMutation(rejectedAction.confirmationId)).resolves.toEqual({ status: "already_rejected" });
    await expect(tasks.list("owner-a")).resolves.toHaveLength(1);
  });

  it("uses the same owner-bound idea deletion confirmation and undo over employee HTTP and Telegram service HTTP", async () => {
    const clock = { now: () => "2026-07-31T09:00:00.000Z" };
    const runtime = createInMemoryRuntime({ agentRunner: async () => "legacy", deps: createDefaultSpecDeps() });
    await prepareOwner(runtime.service, "owner-a", "invite-idea-delete-owner", { chatId: "chat-idea-delete-owner", userId: "telegram-idea-delete-owner" });
    const documents = createInMemoryDocumentStore(clock);
    const ideas = createInMemoryIdeaStore(clock);
    const captured = await ideas.add({ id: "transport-delete-idea", userId: "owner-a", project: "ASSISTANT", type: "knowledge", summary: "Delete through transport", status: "raw" });
    const ingestion = createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock), ideaStore: ideas });
    let deletionConfirmationNumber = 0;
    const deletions = new IdeaDeletionService(ideas, createInMemoryIdeaDeletionConfirmationStore(ideas), clock, { confirmationId: () => `transport-idea-deletion-${++deletionConfirmationNumber}` });
    const assistant = new AssistantService(async (_input, context) => {
      await context.ideas.propose({ ideaId: captured.id, expectedRevision: captured.revision });
      return "Подтвердите удаление.";
    }, {
      documentStore: documents, conversationStore: createInMemoryConversationStore(runtime.world), ingestionService: ingestion,
      ideaStore: ideas, ideaDeletions: deletions, requestIntegrityGuard: async () => ({ status: "allowed" }), clock, idGenerator: createDeterministicIdGenerator(),
    });
    const artifacts = createInMemoryArtifactStore({ contentStore: createInMemoryArtifactContentStore(clock), clock, limits: { maximumBytes: 1024, timeoutMs: 1_000 } });
    const server = await listenHttpServer({
      application: new PersonalAssistantService(runtime.service, assistant, artifacts, undefined, undefined, deletions),
      port: 0, logger: () => undefined, auth: { serviceToken, employeeTokens: new Map([["owner-a", ownerToken]]) },
    });
    running.push(server);
    const employee = new EmployeeMinutkaClient(new HttpEmployeeMinutkaTransport({ baseUrl: server.url, token: ownerToken }));
    const telegram = new ServiceMinutkaClient(new HttpServiceMinutkaTransport({ baseUrl: server.url, token: serviceToken })).forEmployee("owner-a");

    const proposed = await employee.chat({ threadId: "idea-delete", text: "delete it" });
    if (proposed.pendingActions[0]?.actionKind !== "delete_idea") throw new Error("expected idea deletion pending action");
    const deletionAction = proposed.pendingActions[0];
    await expect(telegram.confirmIdeaDeletion(deletionAction.confirmationId)).resolves.toMatchObject({ status: "confirmed", outcome: { outcome: "deleted" } });
    await expect(telegram.confirmIdeaDeletion(deletionAction.confirmationId)).resolves.toMatchObject({ status: "already_confirmed", outcome: { outcome: "deleted" } });
    await expect(ideas.get("owner-a", captured.id)).resolves.toBeNull();
    await expect(employee.undoIdeaDeletion()).resolves.toMatchObject({ outcome: "restored", idea: { id: captured.id } });
    await expect(ideas.get("owner-a", captured.id)).resolves.toMatchObject({ revision: 3 });

    const restored = await ideas.get("owner-a", captured.id);
    if (!restored) throw new Error("expected restored idea");
    const rejectionProposal = await deletions.propose("owner-a", { ideaId: restored.id, expectedRevision: restored.revision });
    if (rejectionProposal.status !== "needs_confirmation") throw new Error("expected idea deletion confirmation");
    await expect(telegram.rejectIdeaDeletion(rejectionProposal.confirmation.confirmationId)).resolves.toEqual({ status: "rejected" });
    await expect(telegram.rejectIdeaDeletion(rejectionProposal.confirmation.confirmationId)).resolves.toEqual({ status: "already_rejected" });
    await expect(ideas.get("owner-a", captured.id)).resolves.toMatchObject({ revision: 3 });
  });

  it("keeps proposals actionable through HTTP and Telegram when conversation history persistence fails", async () => {
    const clock = { now: () => "2026-07-29T09:00:00.000Z" };
    const runtime = createInMemoryRuntime({ agentRunner: async () => "legacy", deps: createDefaultSpecDeps() });
    await prepareOwner(runtime.service, "owner-a", "invite-history-failure", { chatId: "chat-a", userId: "telegram-a" });
    const documents = createInMemoryDocumentStore(clock);
    const ideas = createInMemoryIdeaStore(clock);
    const tasks = createInMemoryTaskStore(clock);
    const ingestion = createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock), ideaStore: ideas });
    let confirmationNumber = 0;
    const taskMutations = new TaskMutationConfirmationService(
      createInMemoryTaskMutationConfirmationStore(tasks), clock,
      { confirmationId: () => `history-failure-confirmation-${++confirmationNumber}` },
    );
    let agentCalls = 0;
    let conversationAppends = 0;
    const assistant = new AssistantService(async (_input, context) => {
      agentCalls += 1;
      await context.tasks.propose({ kind: "create", title: `Visible proposal ${agentCalls}`, project: "ASSISTANT", type: "operations" });
      return "Предложение подготовлено.";
    }, {
      documentStore: documents,
      conversationStore: {
        ...createInMemoryConversationStore(runtime.world),
        async appendTurn() {
          conversationAppends += 1;
          throw new Error("conversation unavailable");
        },
      },
      ingestionService: ingestion,
      ideaStore: ideas,
      taskStore: tasks,
      taskMutations: { propose: taskMutations.propose.bind(taskMutations) },
      requestIntegrityGuard: async () => ({ status: "allowed" }),
      clock,
      idGenerator: createDeterministicIdGenerator(),
    });
    const artifacts = createInMemoryArtifactStore({ contentStore: createInMemoryArtifactContentStore(clock), clock, limits: { maximumBytes: 1024, timeoutMs: 1_000 } });
    const server = await listenHttpServer({
      application: new PersonalAssistantService(runtime.service, assistant, artifacts, taskMutations),
      port: 0,
      logger: () => undefined,
      auth: { serviceToken, employeeTokens: new Map([["owner-a", ownerToken]]) },
    });
    running.push(server);

    const employee = new EmployeeMinutkaClient(new HttpEmployeeMinutkaTransport({ baseUrl: server.url, token: ownerToken }));
    const httpProposal = await employee.chat({ threadId: "http-history-failure", text: "create over HTTP" });
    if (!httpProposal.pendingActions[0]) throw new Error("expected HTTP pending action");
    const httpAction = httpProposal.pendingActions[0];
    expect(httpProposal).toMatchObject({ response: "Предложение подготовлено.", effect: "pending_action_created" });
    await expect(employee.confirmTaskMutation(httpAction.confirmationId)).resolves.toMatchObject({ status: "confirmed" });
    await expect(employee.confirmTaskMutation(httpAction.confirmationId)).resolves.toMatchObject({ status: "already_confirmed" });

    const sent: Array<{ messageId: number; text: string; replyMarkup?: { inlineKeyboard: Array<Array<{ text: string; callbackData: string }>> } }> = [];
    const callbackAnswers: string[] = [];
    const telegram = createTelegramShell({
      privacyExplanation: executableSpecPrivacyExplanation,
      client: new ServiceMinutkaClient(new HttpServiceMinutkaTransport({ baseUrl: server.url, token: serviceToken })),
      sessionStore: runtime.telegramSessionStore,
      replyPort: {
        async sendMessage(_chatId, text, options) {
          const message = { messageId: sent.length + 1, text, ...(options?.replyMarkup ? { replyMarkup: options.replyMarkup } : {}) };
          sent.push(message);
          return { messageId: message.messageId };
        },
        async sendChatAction() {},
        async editReplyMarkup() {},
        async answerCallbackQuery(_callbackQueryId, text) { if (text) callbackAnswers.push(text); },
      },
    });
    await telegram.handleText("chat-a", "create over Telegram", "telegram-a");
    const telegramProposal = sent.find((message) => message.text.includes("Предложение:"));
    const confirmCallback = telegramProposal?.replyMarkup?.inlineKeyboard.flat().find(({ text }) => text === "✅ Подтвердить")?.callbackData;
    if (!telegramProposal || !confirmCallback) throw new Error("expected Telegram proposal buttons");
    await telegram.handleCallback("chat-a", "confirm-history-failure", confirmCallback, "telegram-a", telegramProposal.messageId);

    expect(callbackAnswers.at(-1)).toBe("Изменение сохранено.");
    expect(agentCalls).toBe(2);
    expect(conversationAppends).toBe(2);
    await expect(ideas.list("owner-a")).resolves.toEqual([]);
    await expect(tasks.list("owner-a")).resolves.toMatchObject([{ title: "Visible proposal 1" }, { title: "Visible proposal 2" }]);
    await expect(tasks.list("owner-a")).resolves.toHaveLength(2);
  });

  it("preserves pre-write, post-write, and uncertain-write messages for Telegram without repeating dispatch or capture", async () => {
    const clock = { now: () => "2026-07-16T09:00:00.000Z" };
    const runtime = createInMemoryRuntime({ agentRunner: async () => "legacy", deps: createDefaultSpecDeps() });
    await prepareOwner(runtime.service, "owner-a", "invite-a", { chatId: "chat-a", userId: "telegram-a" });

    const documents = createInMemoryDocumentStore(clock);
    const ideas = createInMemoryIdeaStore(clock);
    const ingestion = createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock), ideaStore: ideas });
    let dispatches = 0;
    const assistant = new AssistantService(async (input, context) => {
      dispatches += 1;
      if (input.text === "uncertain idea") {
        try {
          await context.captureIdea({
            project: "ASSISTANT",
            type: "development",
            summary: "uncertain capture",
            suggestedNextStep: "Check the list",
            needsProjectClarification: false,
          });
        } catch {
          throw new Error("maximum context length exceeded");
        }
      } else if (input.text !== "pre-write idea") {
        await context.captureIdea({
          project: "ASSISTANT",
          type: "development",
          summary: `captured:${input.text}`,
          suggestedNextStep: "Continue later",
          needsProjectClarification: false,
        });
      }
      throw new Error("maximum context length exceeded");
    }, {
      documentStore: documents,
      conversationStore: createInMemoryConversationStore(runtime.world),
      ingestionService: {
        ...ingestion,
        async captureIdea(input) {
          if (input.summary !== "uncertain capture") return ingestion.captureIdea(input);
          await ingestion.captureIdea(input);
          throw new Error("connection lost after commit");
        },
      },
      ideaStore: ideas,
      requestIntegrityGuard: async () => ({ status: "allowed" }),
      clock,
      idGenerator: createDeterministicIdGenerator(),
    });
    const artifactStore = createInMemoryArtifactStore({
      contentStore: createInMemoryArtifactContentStore(clock),
      clock,
      limits: { maximumBytes: 1024, timeoutMs: 1_000 },
    });
    const server = await listenHttpServer({
      application: new PersonalAssistantService(runtime.service, assistant, artifactStore),
      port: 0,
      logger: () => undefined,
      auth: { serviceToken, employeeTokens: new Map([["owner-a", ownerToken]]) },
    });
    running.push(server);

    const replies: string[] = [];
    const telegram = createTelegramShell({
      privacyExplanation: executableSpecPrivacyExplanation,
      client: new ServiceMinutkaClient(new HttpServiceMinutkaTransport({ baseUrl: server.url, token: serviceToken })),
      sessionStore: runtime.telegramSessionStore,
      voiceFileGateway: { async openVoiceFile() { return { stream: Readable.from("voice"), filetype: "ogg" }; } },
      speechToText: { async transcribe() { return "voice idea"; } },
      replyPort: {
        async sendMessage(_chatId, text) { replies.push(text); return { messageId: replies.length }; },
        async sendChatAction() {},
        async editReplyMarkup() {},
        async answerCallbackQuery() {},
      },
    });

    await telegram.handleText("chat-a", "pre-write idea", "telegram-a");
    expect(replies).toEqual([overflowRecoveryUserMessage]);
    expect(dispatches).toBe(2);
    await expect(ideas.list("owner-a")).resolves.toHaveLength(1);

    replies.length = 0;
    await telegram.handleText("chat-a", "text idea", "telegram-a");
    expect(replies).toEqual([overflowAfterDurableWriteUserMessage]);
    expect(dispatches).toBe(3);
    await expect(ideas.list("owner-a")).resolves.toHaveLength(2);

    replies.length = 0;
    await telegram.handleText("chat-a", "uncertain idea", "telegram-a");
    expect(replies).toEqual([mutationOutcomeUnknownUserMessage]);
    expect(dispatches).toBe(4);
    await expect(ideas.list("owner-a")).resolves.toHaveLength(3);

    replies.length = 0;
    await telegram.handleVoice("chat-a", { fileId: "voice-file", messageId: 42, durationSeconds: 1 }, "telegram-a");
    expect(replies).toEqual(["Распознано:\nvoice idea", overflowAfterDurableWriteUserMessage]);
    expect(dispatches).toBe(5);
    await expect(ideas.list("owner-a")).resolves.toHaveLength(4);
    expect(runtime.world.messages).toEqual([]);
  });
});

async function prepareOwner(
  service: ReturnType<typeof createInMemoryRuntime>["service"],
  employeeId: string,
  inviteCode: string,
  telegramIdentity?: { chatId: string; userId: string },
): Promise<void> {
  await service.issueInvite({ employeeId, inviteCode });
  if (telegramIdentity) await service.redeemTelegramInvite({ inviteCode, identity: telegramIdentity });
  await service.acceptConsent({ employeeId, accepted: true, source: "test", ...(telegramIdentity ? { telegramIdentity } : {}) });
  await service.completeOnboarding({ employeeId, role: "Owner", typicalTasks: ["planning"], persona: "efficiency", aiLevel: "advanced" });
}
