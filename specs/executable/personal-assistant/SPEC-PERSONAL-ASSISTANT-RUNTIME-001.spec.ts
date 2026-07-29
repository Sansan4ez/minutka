import { describe, expect, it } from "vitest";
import type { AgentRunner } from "../../../src/application/minutka-service.js";
import { createDeterministicIdGenerator } from "../../../src/application/runtime-primitives.js";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { createInMemoryAuditEventStore } from "../../../src/application/in-memory-audit-event-store.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";
import { createInMemoryWorld } from "../../../src/application/in-memory-world.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { createInMemoryRuntime, executableSpecPrivacyExplanation } from "../../../src/runtime/create-in-memory-runtime.js";
import { createDefaultSpecDeps } from "../support/scripted-deps.js";
import { ServiceMinutkaClient, type ServiceMinutkaTransport } from "../../../src/client/sdk/minutka-client.js";
import { createInProcessServiceTransport } from "../../../src/server/http/in-process-transport.js";
import { createTelegramShell } from "../../../src/telegram/telegram-shell.js";
import { createInMemoryArtifactContentStore } from "../../../src/application/in-memory-artifact-content-store.js";
import { createInMemoryArtifactStore } from "../../../src/application/in-memory-artifact-store.js";
import { Readable } from "node:stream";

const noOpAgent: AgentRunner = async () => "legacy";

describe("SPEC-PERSONAL-ASSISTANT-RUNTIME-001: production-shaped Telegram composition", () => {
  it("uses AssistantService for a profile-ready Telegram text message", async () => {
    const world = createInMemoryWorld(() => "2026-07-15T09:00:00.000Z");
    const legacy = createInMemoryRuntime({ world, agentRunner: noOpAgent, deps: createDefaultSpecDeps() });
    await legacy.service.issueInvite({ employeeId: "maxim", inviteCode: "invite" });
    await legacy.service.redeemTelegramInvite({ inviteCode: "invite", identity: { chatId: "1", userId: "user-1" } });
    await legacy.service.acceptConsent({ employeeId: "maxim", accepted: true, source: "test", telegramIdentity: { chatId: "1", userId: "user-1" } });
    await legacy.service.completeOnboarding({ employeeId: "maxim", role: "Owner", typicalTasks: ["ideas"], persona: "efficiency", aiLevel: "advanced" });

    const clock = { now: world.now };
    const documents = createInMemoryDocumentStore(clock);
    const blobs = createInMemoryBlobStore(clock);
    const ideas = createInMemoryIdeaStore(clock);
    const ingestion = createIngestionService({ documentStore: documents, blobStore: blobs, ideaStore: ideas });
    let assistantSystemContext = "";
    const assistant = new AssistantService(async (_input, context) => {
      assistantSystemContext = context.systemContext;
      const saved = await context.captureIdea({ project: "АССИСТЕНТ", type: "development", summary: "Runtime подключён", suggestedNextStep: "Проверить запись.", needsProjectClarification: false });
      return saved.response;
    }, {
      documentStore: documents,
      conversationStore: createInMemoryConversationStore(world),
      ingestionService: ingestion,
      ideaStore: ideas,
      auditEventStore: createInMemoryAuditEventStore(world),
      requestIntegrityGuard: async () => ({ status: "allowed" }),
      clock,
      idGenerator: createDeterministicIdGenerator(),
    });
    const replies: Array<{ text: string; options?: unknown }> = [];
    const downloadedFiles: string[] = [];
    const artifactStore = createInMemoryArtifactStore({ contentStore: createInMemoryArtifactContentStore(clock), clock, limits: { maximumBytes: 1024, timeoutMs: 1_000 } });
    const baseTransport = createInProcessServiceTransport(legacy.service, { kind: "service", serviceId: "telegram" });
    const transport: ServiceMinutkaTransport = {
      redeemTelegramInvite: (input) => baseTransport.redeemTelegramInvite(input),
      forEmployee(employeeId) {
        const scoped = baseTransport.forEmployee(employeeId);
        return new Proxy(scoped, {
          get(target, property, receiver) {
            if (property === "chat") return async (input: Parameters<typeof scoped.chat>[0]) => {
              const result = await assistant.chat({ userId: employeeId, threadId: input.threadId, text: input.text, inputModality: input.inputModality, responseChannel: input.responseChannel });
              return { messageId: result.messageId, response: result.response, selectedProcessIds: result.selectedProcessIds, ...(result.pendingAction ? { pendingAction: result.pendingAction } : {}), effect: result.effect };
            };
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    };
    const client = new ServiceMinutkaClient(transport);
    const shell = createTelegramShell({
      privacyExplanation: executableSpecPrivacyExplanation, client,
      sessionStore: legacy.telegramSessionStore,
      artifactIntake: { saveArtifact: (input) => artifactStore.save(input) },
      fileGateway: { createFileBody({ fileId, fileSizeBytes }) { downloadedFiles.push(fileId); return { ...(fileSizeBytes === undefined ? {} : { size: fileSizeBytes }), openStream: () => Readable.from("photo") }; } },
      replyPort: { async sendMessage(_chatId, text, options) { replies.push({ text, options }); return { messageId: replies.length }; }, async sendChatAction() {}, async editReplyMarkup() {}, async answerCallbackQuery() {} },
    });

    await shell.handleText("1", "Не потеряй мысль", "user-1");

    await expect(ideas.list("maxim")).resolves.toMatchObject([{ summary: "Runtime подключён", source: { kind: "text", text: "Не потеряй мысль" } }]);
    expect(replies).toHaveLength(1);
    expect(replies[0]?.text).toBe("Сохранил идею: Runtime подключён. Следующий шаг: Проверить запись.");
    expect(replies[0]?.options).toMatchObject({ replyMarkup: { inlineKeyboard: [[{ text: "👍" }, { text: "👌" }, { text: "👎" }]] } });
    expect(assistantSystemContext).toContain("## Trusted response policy");
    expect(assistantSystemContext).toContain("Channel: telegram");
    expect(assistantSystemContext).toContain("Preferred response length: balanced");
    expect(assistantSystemContext).toContain("Target budget: about 1200 Unicode characters; no more than 4 short blocks.");

    replies.length = 0;
    await shell.handleFile("1", { fileId: "photo-1", fileUniqueId: "photo-unique-1", messageId: 2, payloadKind: "photo", fileName: "photo.jpg", declaredMediaType: "image/jpeg", caption: "Фото мысли", fileSizeBytes: 5, forwarded: false }, "user-1");
    expect(downloadedFiles).toEqual(["photo-1"]);
    await expect(ideas.list("maxim")).resolves.toHaveLength(1);
    await expect(artifactStore.list("maxim")).resolves.toMatchObject([{ originalFileName: "photo.jpg", caption: "Фото мысли", source: { payloadKind: "photo" } }]);
    expect(replies.at(-1)?.text).toBe("Файл сохранён.");
  });
});
