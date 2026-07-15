import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { AssistantService } from "../../../src/application/assistant-service.js";
import { ArtifactSaveTimeoutError, ArtifactTooLargeError } from "../../../src/application/artifact-body-stager.js";
import type { SaveArtifactInput, SaveArtifactResult } from "../../../src/application/artifact-store.js";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import { ServiceMinutkaClient } from "../../../src/client/sdk/minutka-client.js";
import { createInProcessServiceTransport } from "../../../src/server/http/in-process-transport.js";
import { createTelegramShell, maxTelegramArtifactFileSizeBytes, type TelegramFileAttachment } from "../../../src/telegram/telegram-shell.js";
import { createDefaultSpecDeps } from "../support/scripted-deps.js";

async function setup(input: { saveError?: Error } = {}) {
  const runtime = createInMemoryRuntime({ agentRunner: async () => "legacy", deps: createDefaultSpecDeps() });
  await runtime.service.issueInvite({ employeeId: "maxim", inviteCode: "invite" });
  await runtime.service.redeemTelegramInvite({ inviteCode: "invite", identity: { chatId: "1", userId: "user-1" } });
  await runtime.service.acceptConsent({ employeeId: "maxim", accepted: true, source: "test", telegramIdentity: { chatId: "1", userId: "user-1" } });
  await runtime.service.completeOnboarding({ employeeId: "maxim", role: "Owner", typicalTasks: ["ideas"], persona: "efficiency", aiLevel: "advanced" });

  const calls: Array<Parameters<AssistantService["chat"]>[0]> = [];
  const saved: SaveArtifactInput[] = [];
  const createdBodies: string[] = [];
  const downloads: string[] = [];
  const transcriptions: string[] = [];
  const replies: string[] = [];
  const deliveryArtifacts = new Map<string, SaveArtifactResult>();
  const client = new ServiceMinutkaClient(createInProcessServiceTransport(runtime.service, { kind: "service", serviceId: "telegram" }));
  const shell = createTelegramShell({
    client,
    sessionStore: runtime.telegramSessionStore,
    assistant: { async chat(chat) { calls.push(chat); return { messageId: `msg-${calls.length}`, response: "Ответ", selectedProcessIds: ["core"] as ["core"] }; } },
    artifactStore: {
      async save(file) {
        if (input.saveError) throw input.saveError;
        const duplicate = deliveryArtifacts.get(file.source.deliveryKey);
        if (duplicate) return { ...duplicate, deliveryDisposition: "duplicate_delivery" };
        await read(file.body.openStream());
        saved.push(file);
        const result: SaveArtifactResult = {
          artifact: { ownerId: file.ownerId, artifactId: file.artifactId, contentDigest: "a".repeat(64), originalFileName: file.originalFileName, size: file.body.size ?? 0, source: file.source, status: "active", createdAt: "2026-07-15T09:00:00.000Z" },
          deliveryDisposition: "created", contentDisposition: "stored",
        };
        deliveryArtifacts.set(file.source.deliveryKey, result);
        return result;
      },
    },
    fileGateway: { createFileBody(file) { createdBodies.push(file.fileId); return { ...(file.fileSizeBytes === undefined ? {} : { size: file.fileSizeBytes }), openStream: () => { downloads.push(file.fileId); return Readable.from("file"); } }; } },
    speechToText: { async transcribe() { transcriptions.push("voice"); return "Голосовая мысль"; } },
    voiceFileGateway: { async openVoiceFile() { return { stream: Readable.from("voice"), filetype: "ogg" }; } },
    replyPort: { async sendMessage(_chatId, text) { replies.push(text); }, async sendChatAction() {}, async answerCallbackQuery() {} },
  });
  return { shell, calls, saved, createdBodies, downloads, transcriptions, replies };
}

async function read(stream: NodeJS.ReadableStream): Promise<void> { for await (const _chunk of stream) { /* consume */ } }

function attachment(overrides: Partial<TelegramFileAttachment> = {}): TelegramFileAttachment {
  return {
    fileId: "file-1", fileUniqueId: "unique-1", messageId: 10, payloadKind: "document", fileName: "report.pdf",
    declaredMediaType: "application/pdf", caption: "Квартальный отчёт", fileSizeBytes: 4, forwarded: false, ...overrides,
  };
}

describe("SPEC-PERSONAL-ASSISTANT-TELEGRAM-001: production inbox channel normalization", () => {
  it("keeps voice interactive but saves document, audio, photo, video, and animation without calling the assistant", async () => {
    const { shell, calls, saved, transcriptions, replies } = await setup();
    await shell.handleVoice("1", { fileId: "voice", messageId: 1, durationSeconds: 5 }, "user-1");
    for (const [index, payloadKind] of (["document", "audio", "photo", "video", "animation"] as const).entries()) {
      await shell.handleFile("1", attachment({ fileId: `file-${index}`, fileUniqueId: `unique-${index}`, messageId: index + 10, payloadKind }), "user-1");
    }

    expect(transcriptions).toEqual(["voice"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ text: "Голосовая мысль", inputModality: "voice", source: { kind: "text" } });
    expect(saved.map((file) => file.source.kind === "telegram" ? file.source.payloadKind : "other")).toEqual(["document", "audio", "photo", "video", "animation"]);
    expect(replies.filter((reply) => reply === "Файл сохранён.")).toHaveLength(5);
  });

  it("persists Telegram provenance, caption, and filename and deduplicates a delivery retry", async () => {
    const { shell, saved, createdBodies, downloads } = await setup();
    const file = attachment({ forwarded: true, mediaGroupId: "album-1" });
    await shell.handleFile("1", file, "user-1");
    await shell.handleFile("1", file, "user-1");

    expect(saved).toHaveLength(1);
    expect(createdBodies).toEqual(["file-1", "file-1"]);
    expect(downloads).toEqual(["file-1"]);
    expect(saved[0]).toMatchObject({ ownerId: "maxim", originalFileName: "report.pdf", declaredMediaType: "application/pdf", caption: "Квартальный отчёт" });
    expect(saved[0]?.source).toEqual({
      kind: "telegram", deliveryKey: "telegram:1:10:document:unique-1", chatId: "1", messageId: 10,
      payloadKind: "document", forwarded: true, fileId: "file-1", fileUniqueId: "unique-1", mediaGroupId: "album-1",
    });
  });

  it("checks authorization, consent, and declared size before creating a network body", async () => {
    const { shell, createdBodies, downloads, replies } = await setup();
    await shell.handleFile("unknown", attachment(), "unknown-user");
    await shell.handleFile("1", attachment({ messageId: 11, fileSizeBytes: maxTelegramArtifactFileSizeBytes + 1 }), "user-1");
    expect(createdBodies).toEqual([]);
    expect(downloads).toEqual([]);
    expect(replies).toContain("Откройте бота по индивидуальной ссылке /start <code>");
    expect(replies.at(-1)).toContain("Файл слишком большой");
  });

  it.each([
    [new ArtifactTooLargeError(), "Файл слишком большой"],
    [new ArtifactSaveTimeoutError(), "Не удалось сохранить файл вовремя"],
    [new Error("stream failed"), "Не удалось сохранить файл"],
  ])("returns a clear persistence error without calling the assistant", async (error, expected) => {
    const { shell, calls, replies } = await setup({ saveError: error });
    await shell.handleFile("1", attachment(), "user-1");
    expect(calls).toHaveLength(0);
    expect(replies.at(-1)).toContain(expected);
  });

  it("rejects video notes explicitly without downloading them", async () => {
    const { shell, downloads, replies } = await setup();
    await shell.handleUnsupportedAttachment("1", "user-1");
    expect(downloads).toEqual([]);
    expect(replies.at(-1)).toBe("Этот тип вложения пока не поддерживается.");
  });
});
