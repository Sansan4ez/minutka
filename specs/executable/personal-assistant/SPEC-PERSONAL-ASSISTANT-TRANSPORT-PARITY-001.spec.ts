import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantService, type AssistantAgentContext } from "../../../src/application/assistant-service.js";
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
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
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
    await artifactStore.save({
      ownerId: "owner-a",
      artifactId: "artifact-owner-a",
      originalFileName: "private.txt",
      declaredMediaType: "text/plain",
      source: { kind: "http_upload", deliveryKey: "upload-owner-a" },
      body: { size: 7, openStream: () => Readable.from("private") },
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

    const server = await listenHttpServer({
      service: runtime.service,
      assistant,
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
      client: new ServiceMinutkaClient(new HttpServiceMinutkaTransport({ baseUrl: server.url, token: serviceToken })),
      sessionStore: runtime.telegramSessionStore,
      replyPort: {
        async sendMessage(_chatId, text) { telegramReplies.push(text); },
        async sendChatAction() {},
        async answerCallbackQuery() {},
      },
    });
    await telegram.handleText("chat-a", "from Telegram", "telegram-a");

    const ownerHttp = new EmployeeMinutkaClient(new HttpEmployeeMinutkaTransport({ baseUrl: server.url, token: ownerToken }));
    const otherOwnerHttp = new EmployeeMinutkaClient(new HttpEmployeeMinutkaTransport({ baseUrl: server.url, token: otherOwnerToken }));
    await expect(ownerHttp.chat({ threadId: "http-owner-a", text: "from HTTP" })).resolves.toMatchObject({ response: "assistant:from HTTP" });
    await expect(otherOwnerHttp.chat({ threadId: "http-owner-b", text: "isolation probe" })).resolves.toMatchObject({ response: "assistant:isolation probe" });

    expect(telegramReplies[0]).toBe("assistant:from Telegram");
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
    await expect(artifactStore.get("owner-b", "artifact-owner-a")).resolves.toBeNull();
    await expect(artifactStore.list("owner-b")).resolves.toEqual([]);
    await expect(artifactStore.list("owner-a")).resolves.toMatchObject([{ artifactId: "artifact-owner-a" }]);
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
