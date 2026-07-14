import { describe, expect, it } from "vitest";
import { createSpecWorld, expectEvent, registerSpecMetadata } from "../support/spec-harness.js";
import { TelegramDriver } from "../support/telegram-driver.js";
import { onboardTestEmployee } from "../support/onboarding-helper.js";
import { testInvite } from "../support/fixtures.js";
import type { AgentRunner } from "../../../src/application/minutka-service.js";
import { maxVoiceFileSizeBytes } from "../../../src/telegram/telegram-shell.js";

registerSpecMetadata({
  id: "SPEC-VOICE-001",
  userStory: "US-VOICE-001",
  requirements: ["FR-VOICE-001"],
  productParts: ["telegram-bot-shell", "ai-agent-backend-runtime", "data-storage-and-privacy-layer"],
  contracts: ["telegram-shell", "speech-to-text", "chat"],
  events: ["ChatMessageReceived", "ChatResponseGenerated"],
  mastra: [],
  cli: [],
});

const runner: AgentRunner = async () => "Готово: выделите один следующий шаг.";

async function connectedDriver() {
  const spec = createSpecWorld(runner);
  const telegram = new TelegramDriver(spec.world, runner);
  await onboardTestEmployee(spec);
  await telegram.start({ chatId: "voice_chat", userId: "voice_user", inviteCode: testInvite.inviteCode });
  const consent = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
  await telegram.clickCallback({ chatId: "voice_chat", userId: "voice_user", callbackData: consent! });
  telegram.clear();
  return { spec, telegram };
}

describe("SPEC-VOICE-001: Telegram voice converges to the text chat path", () => {
  it("transcribes voice, produces feedback buttons, and writes privacy-safe modality metadata", async () => {
    const { spec, telegram } = await connectedDriver();

    await telegram.sendVoice({ chatId: "voice_chat", userId: "voice_user", fileId: "voice_1", durationSeconds: 12, fileSizeBytes: 1_024, transcript: "Сегодня хочу закрыть квартальный отчёт." });

    expect(telegram.voiceDownloadCalls()).toEqual(["voice_1"]);
    expect(telegram.transcriptionCalls()).toEqual(["voice_1"]);
    const reply = telegram.sentMessages()[0];
    expect(reply.text).toContain("следующий шаг");
    expect(reply.replyMarkup?.inlineKeyboard[0]).toHaveLength(3);
    expectEvent(spec, { type: "ChatMessageReceived", text: "[private]", inputModality: "voice" });
    const audit = spec.world.auditEvents.find((event) => event.type === "chat_received")!;
    expect(audit).toMatchObject({ messageId: expect.any(String), metadata: { inputModality: "voice" } });
    expect(JSON.stringify({ events: spec.world.events, auditEvents: spec.world.auditEvents })).not.toContain("voice_1");
    expect(JSON.stringify({ events: spec.world.events, auditEvents: spec.world.auditEvents })).not.toContain("1024");

    await telegram.clickFeedback({ chatId: "voice_chat", userId: "voice_user", rating: "positive", targetMessageId: audit.messageId! });
    expect(spec.world.feedback).toHaveLength(1);
  });

  it("keeps normal text modality at text", async () => {
    const { spec, telegram } = await connectedDriver();
    await telegram.sendText({ chatId: "voice_chat", userId: "voice_user", text: "Текстовое сообщение" });
    expect(spec.world.events.find((event) => event.type === "ChatMessageReceived")).toMatchObject({ inputModality: "text" });
    expect(spec.world.auditEvents.find((event) => event.type === "chat_received")?.metadata).toEqual({ inputModality: "text" });
  });

  it("rejects unauthorised, unconsented, too-long, and too-large voice before download", async () => {
    const spec = createSpecWorld(runner);
    const telegram = new TelegramDriver(spec.world, runner);
    await telegram.sendVoice({ chatId: "unknown", fileId: "unknown_voice", durationSeconds: 1, transcript: "ignored" });
    expect(telegram.voiceDownloadCalls()).toEqual([]);
    expect(telegram.sentMessages().at(-1)?.text).toBe("Откройте бота по индивидуальной ссылке /start <code>");

    await onboardTestEmployee(spec);
    await telegram.start({ chatId: "pending", userId: "pending_user", inviteCode: testInvite.inviteCode });
    telegram.clear();
    await telegram.sendVoice({ chatId: "pending", userId: "pending_user", fileId: "unconsented", durationSeconds: 1, transcript: "ignored" });
    expect(telegram.voiceDownloadCalls()).toEqual([]);
    expect(telegram.sentMessages().at(-1)?.text).toBe("Сначала подтвердите согласие с политикой конфиденциальности.");

    const connected = await connectedDriver();
    await connected.telegram.sendVoice({ chatId: "voice_chat", userId: "voice_user", fileId: "long", durationSeconds: 301, transcript: "ignored" });
    await connected.telegram.sendVoice({ chatId: "voice_chat", userId: "voice_user", fileId: "large", durationSeconds: 1, fileSizeBytes: maxVoiceFileSizeBytes + 1, transcript: "ignored" });
    await connected.telegram.sendVoice({ chatId: "voice_chat", userId: "voice_user", fileId: "size_unknown", durationSeconds: 1, audioBytes: maxVoiceFileSizeBytes + 1, transcript: "ignored" });
    expect(connected.telegram.voiceDownloadCalls()).toEqual(["size_unknown"]);
    expect(connected.telegram.transcriptionCalls()).toEqual([]);
    expect(connected.telegram.sentMessages().map((message) => message.text)).toEqual(expect.arrayContaining([
      expect.stringContaining("слишком длинное"), expect.stringContaining("слишком большое"),
    ]));
  });

  it("handles download/STT errors, blank and oversized transcripts without chat", async () => {
    const { spec, telegram } = await connectedDriver();
    await telegram.sendVoice({ chatId: "voice_chat", userId: "voice_user", fileId: "download_error", durationSeconds: 1, error: "download" });
    await telegram.sendVoice({ chatId: "voice_chat", userId: "voice_user", fileId: "stt_error", durationSeconds: 1, error: "transcribe" });
    await telegram.sendVoice({ chatId: "voice_chat", userId: "voice_user", fileId: "empty", durationSeconds: 1, transcript: "   " });
    await telegram.sendVoice({ chatId: "voice_chat", userId: "voice_user", fileId: "oversized", durationSeconds: 1, transcript: "а".repeat(4097) });
    expect(spec.world.messages).toHaveLength(0);
    expect(telegram.sentMessages().map((message) => message.text)).toEqual(expect.arrayContaining([
      "Не удалось обработать голосовое сообщение. Попробуйте ещё раз позже.",
      "Не удалось распознать голосовое сообщение. Попробуйте ещё раз или напишите текстом.",
      "Сообщение слишком длинное (максимум 4096 символов).",
    ]));
  });

  it("uses voice transcript for conversational onboarding before profile creation", async () => {
    const spec = createSpecWorld(runner);
    const telegram = new TelegramDriver(spec.world, runner);
    await spec.cli.run(["employee", "issue-invite", "--invite", "voice_onboarding_invite", "--employee", "voice_onboarding_employee"]);
    await telegram.start({ chatId: "onboarding_voice", userId: "onboarding_user", inviteCode: "voice_onboarding_invite" });
    const consent = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.clickCallback({ chatId: "onboarding_voice", userId: "onboarding_user", callbackData: consent! });
    telegram.clear();

    await telegram.sendVoice({ chatId: "onboarding_voice", userId: "onboarding_user", fileId: "onboarding", durationSeconds: 5, transcript: "Аналитик | отчёты | Поддержка | Начинающий" });
    expect(telegram.sentMessages()[0].text).toContain("Проверьте, пожалуйста");
    expect(spec.world.messages).toHaveLength(0);
  });

  it("shares the in-flight guard between voice and text", async () => {
    let telegram!: TelegramDriver;
    const delayed: AgentRunner = async (input) => {
      if (input.text === "first") await telegram.sendText({ chatId: "voice_chat", userId: "voice_user", text: "parallel text" });
      return "response";
    };
    const spec = createSpecWorld(delayed);
    telegram = new TelegramDriver(spec.world, delayed);
    await onboardTestEmployee(spec);
    await telegram.start({ chatId: "voice_chat", userId: "voice_user", inviteCode: testInvite.inviteCode });
    const consent = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.clickCallback({ chatId: "voice_chat", userId: "voice_user", callbackData: consent! });
    telegram.clear();

    await telegram.sendVoice({ chatId: "voice_chat", userId: "voice_user", fileId: "parallel_voice", durationSeconds: 1, transcript: "first" });
    expect(telegram.sentMessages().map((message) => message.text)).toContain("Пожалуйста, подождите, я ещё отвечаю на предыдущее сообщение.");
    expect(spec.world.messages).toHaveLength(1);
  });
});
