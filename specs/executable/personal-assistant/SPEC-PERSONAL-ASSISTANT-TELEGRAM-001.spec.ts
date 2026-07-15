import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { AssistantService } from "../../../src/application/assistant-service.js";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import { ServiceMinutkaClient } from "../../../src/client/sdk/minutka-client.js";
import { createInProcessServiceTransport } from "../../../src/server/http/in-process-transport.js";
import { createTelegramShell } from "../../../src/telegram/telegram-shell.js";
import { PhotoDownloadTimeoutError, PhotoFileTooLargeError, UnsupportedPhotoContentTypeError } from "../../../src/telegram/telegram-photo-file-gateway.js";
import { createDefaultSpecDeps } from "../support/scripted-deps.js";

async function setup(input: { photoError?: Error; photoDelayMs?: number } = {}) {
  const runtime = createInMemoryRuntime({ agentRunner: async () => "legacy", deps: createDefaultSpecDeps() });
  await runtime.service.issueInvite({ employeeId: "maxim", inviteCode: "invite" });
  await runtime.service.redeemTelegramInvite({ inviteCode: "invite", identity: { chatId: "1", userId: "user-1" } });
  await runtime.service.acceptConsent({ employeeId: "maxim", accepted: true, source: "test", telegramIdentity: { chatId: "1", userId: "user-1" } });
  await runtime.service.completeOnboarding({ employeeId: "maxim", role: "Owner", typicalTasks: ["ideas"], persona: "efficiency", aiLevel: "advanced" });

  const calls: Array<Parameters<AssistantService["chat"]>[0]> = [];
  const assistant = {
    async chat(chat: Parameters<AssistantService["chat"]>[0]) {
      calls.push(chat);
      return { messageId: `msg-${calls.length}`, response: "Сохранено", selectedProcessIds: ["core"] as ["core"] };
    },
  };
  const uploaded: Array<{ userId: string; fileName: string; contentType: string }> = [];
  const replies: string[] = [];
  const client = new ServiceMinutkaClient(createInProcessServiceTransport(runtime.service, { kind: "service", serviceId: "telegram" }));
  const shell = createTelegramShell({
    client,
    sessionStore: runtime.telegramSessionStore,
    assistant,
    ingestion: { async captureInboxFile(file) { uploaded.push(file); return { userId: file.userId, key: "inbox/photo.jpg", contentType: file.contentType, size: file.body.length, createdAt: "2026-07-15T09:00:00.000Z" }; } },
    photoFileGateway: { async downloadPhoto() { if (input.photoDelayMs) await new Promise((resolve) => setTimeout(resolve, input.photoDelayMs)); if (input.photoError) throw input.photoError; return { body: Buffer.from("photo"), contentType: "image/jpeg", fileName: "photo.jpg" }; } },
    speechToText: { async transcribe() { return "Голосовая мысль"; } },
    voiceFileGateway: { async openVoiceFile() { return { stream: Readable.from("voice"), filetype: "ogg" }; } },
    replyPort: { async sendMessage(_chatId, text) { replies.push(text); }, async sendChatAction() {}, async answerCallbackQuery() {} },
    photoProcessingTimeoutMs: 10,
  });
  return { shell, calls, uploaded, replies };
}

describe("SPEC-PERSONAL-ASSISTANT-TELEGRAM-001: production inbox channel normalization", () => {
  it("routes text, link, voice, and photo through the production Telegram shell", async () => {
    const { shell, calls, uploaded } = await setup();
    await shell.handleText("1", "Текстовая мысль", "user-1");
    await shell.handleText("1", "https://example.test/idea", "user-1");
    await shell.handleVoice("1", { fileId: "voice", messageId: 1, durationSeconds: 5 }, "user-1");
    await shell.handlePhoto("1", { fileId: "photo", caption: "Фото идеи" }, "user-1");

    expect(calls.map(({ text, inputModality, source }) => ({ text, inputModality, source }))).toEqual([
      { text: "Текстовая мысль", inputModality: "text", source: { kind: "text", text: "Текстовая мысль" } },
      { text: "https://example.test/idea", inputModality: "text", source: { kind: "text", text: "https://example.test/idea" } },
      { text: "Голосовая мысль", inputModality: "voice", source: { kind: "text", text: "Голосовая мысль" } },
      { text: "Фото идеи", inputModality: "text", source: { kind: "blob", blobKey: "inbox/photo.jpg" } },
    ]);
    expect(uploaded).toEqual([{ userId: "maxim", fileName: "photo.jpg", contentType: "image/jpeg", body: Buffer.from("photo") }]);
  });

  it.each([
    [new PhotoFileTooLargeError(), "Фотография слишком большая"],
    [new UnsupportedPhotoContentTypeError(), "Поддерживаются только фотографии JPEG и PNG"],
    [new PhotoDownloadTimeoutError(), "Не удалось загрузить фотографию вовремя"],
  ])("returns a specific photo error without calling the assistant", async (error, expected) => {
    const { shell, calls, replies } = await setup({ photoError: error });
    await shell.handlePhoto("1", { fileId: "photo" }, "user-1");
    expect(calls).toHaveLength(0);
    expect(replies.at(-1)).toContain(expected);
  });

  it("applies one processing deadline and captures one item per Telegram media group", async () => {
    const timedOut = await setup({ photoDelayMs: 20 });
    await timedOut.shell.handlePhoto("1", { fileId: "slow" }, "user-1");
    expect(timedOut.calls).toHaveLength(0);
    expect(timedOut.replies.at(-1)).toContain("Не удалось загрузить фотографию вовремя");

    const album = await setup();
    await Promise.all([
      album.shell.handlePhoto("1", { fileId: "first", caption: "Альбом", mediaGroupId: "group-1" }, "user-1"),
      album.shell.handlePhoto("1", { fileId: "second", mediaGroupId: "group-1" }, "user-1"),
    ]);
    expect(album.uploaded).toHaveLength(1);
    expect(album.calls).toHaveLength(1);
  });
});
