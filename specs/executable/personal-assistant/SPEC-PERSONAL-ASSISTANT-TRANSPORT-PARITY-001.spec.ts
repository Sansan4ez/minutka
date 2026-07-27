import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantService, type AssistantAgentContext } from "../../../src/application/assistant-service.js";
import { overflowAfterDurableWriteUserMessage, overflowRecoveryUserMessage } from "../../../src/application/assistant-overflow-recovery.js";
import { PersonalAssistantService } from "../../../src/application/personal-assistant-service.js";
import { createInMemoryArtifactContentStore } from "../../../src/application/in-memory-artifact-content-store.js";
import { createInMemoryArtifactStore } from "../../../src/application/in-memory-artifact-store.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
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

  it("preserves pre-write and post-write overflow messages for Telegram without repeating dispatch or capture", async () => {
    const clock = { now: () => "2026-07-16T09:00:00.000Z" };
    const runtime = createInMemoryRuntime({ agentRunner: async () => "legacy", deps: createDefaultSpecDeps() });
    await prepareOwner(runtime.service, "owner-a", "invite-a", { chatId: "chat-a", userId: "telegram-a" });

    const documents = createInMemoryDocumentStore(clock);
    const ideas = createInMemoryIdeaStore(clock);
    const ingestion = createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock), ideaStore: ideas });
    let dispatches = 0;
    const assistant = new AssistantService(async (input, context) => {
      dispatches += 1;
      if (input.text !== "pre-write idea") {
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
      ingestionService: ingestion,
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
    await telegram.handleVoice("chat-a", { fileId: "voice-file", messageId: 42, durationSeconds: 1 }, "telegram-a");
    expect(replies).toEqual(["Распознано:\nvoice idea", overflowAfterDurableWriteUserMessage]);
    expect(dispatches).toBe(4);
    await expect(ideas.list("owner-a")).resolves.toHaveLength(3);
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
