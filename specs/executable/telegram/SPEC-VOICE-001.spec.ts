import { afterEach, describe, expect, it, vi } from "vitest";
import { createSpecWorld, expectEvent, registerSpecMetadata } from "../support/spec-harness.js";
import { TelegramDriver } from "../support/telegram-driver.js";
import { onboardTestEmployee } from "../support/onboarding-helper.js";
import { testInvite } from "../support/fixtures.js";
import type { AgentRunner } from "../../../src/application/minutka-service.js";
import { maxVoiceFileSizeBytes } from "../../../src/telegram/telegram-shell.js";
import { chatRequestSchema, onboardingAnswerRequestSchema } from "../../../src/contracts/minutka-api.js";
import { maxChatInputCharacters } from "../../../src/shared/chat-limits.js";

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

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function connectedDriver(voiceEnabled = true) {
  const spec = createSpecWorld(runner);
  const telegram = new TelegramDriver(spec.world, runner, {}, voiceEnabled);
  await onboardTestEmployee(spec);
  await telegram.start({ chatId: "voice_chat", userId: "voice_user", inviteCode: testInvite.inviteCode });
  const consent = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
  await telegram.clickCallback({ chatId: "voice_chat", userId: "voice_user", callbackData: consent! });
  await telegram.chooseDefaultRole("voice_chat");
  telegram.clear();
  return { spec, telegram };
}

describe("SPEC-VOICE-001: Telegram voice converges to the text chat path", () => {
  it("transcribes voice, produces feedback buttons, and writes privacy-safe modality metadata", async () => {
    const { spec, telegram } = await connectedDriver();

    await telegram.sendVoice({ chatId: "voice_chat", userId: "voice_user", fileId: "voice_1", messageId: 42, durationSeconds: 12, fileSizeBytes: 1_024, transcript: "Сегодня хочу закрыть квартальный отчёт." });

    expect(telegram.voiceDownloadCalls()).toEqual(["voice_1"]);
    expect(telegram.transcriptionCalls()).toEqual(["voice_1"]);
    expect(telegram.sentChatActions()).toEqual([{ chatId: "voice_chat", action: "typing" }]);
    const [transcript, reply] = telegram.sentMessages();
    expect(transcript?.text).toBe("Распознано:\nСегодня хочу закрыть квартальный отчёт.");
    expect(transcript?.replyToMessageId).toBe(42);
    expect(reply?.text).toContain("следующий шаг");
    expect(reply?.replyMarkup?.inlineKeyboard[0]).toHaveLength(3);
    expectEvent(spec, { type: "ChatMessageReceived", text: "[private]", inputModality: "voice" });
    const audit = spec.world.auditEvents.find((event) => event.type === "chat_received")!;
    expect(spec.world.messages).toContainEqual(expect.objectContaining({
      id: audit.messageId,
      text: "Сегодня хочу закрыть квартальный отчёт.",
    }));
    expect(audit).toMatchObject({ messageId: expect.any(String), metadata: { inputModality: "voice" } });
    expect(JSON.stringify({ events: spec.world.events, auditEvents: spec.world.auditEvents })).not.toContain("voice_1");
    expect(JSON.stringify({ events: spec.world.events, auditEvents: spec.world.auditEvents })).not.toContain("1024");

    await telegram.clickFeedback({ chatId: "voice_chat", userId: "voice_user", rating: "positive", targetMessageId: audit.messageId! });
    expect(spec.world.feedback).toHaveLength(1);
  });

  it("keeps one refreshed typing lifecycle across voice download, STT, transcript delivery, and chat", async () => {
    const delayedRunner: AgentRunner = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "Готово";
    };
    const spec = createSpecWorld(delayedRunner);
    const telegram = new TelegramDriver(spec.world, delayedRunner);
    await onboardTestEmployee(spec);
    await telegram.start({ chatId: "voice_chat", userId: "voice_user", inviteCode: testInvite.inviteCode });
    const consent = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.clickCallback({ chatId: "voice_chat", userId: "voice_user", callbackData: consent! });
    await telegram.chooseDefaultRole("voice_chat");
    telegram.clear();
    let refresh: (() => void) | undefined;
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
    vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: TimerHandler) => {
      refresh = callback as () => void;
      return { unref() {} } as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval);

    const processing = telegram.sendVoice({ chatId: "voice_chat", userId: "voice_user", fileId: "slow_voice", durationSeconds: 1, transcript: "Долгий голосовой запрос" });
    await vi.waitFor(() => expect(refresh).toBeTypeOf("function"));
    refresh!();
    await processing;

    expect(telegram.sentChatActions()).toEqual([
      { chatId: "voice_chat", action: "typing" },
      { chatId: "voice_chat", action: "typing" },
    ]);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("observes chat action failures without interrupting the voice response", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { telegram } = await connectedDriver();
    telegram.failNextChatActionDelivery();

    await telegram.sendVoice({ chatId: "voice_chat", userId: "voice_user", fileId: "action_error", durationSeconds: 1, transcript: "Продолжай обработку" });

    expect(telegram.sentMessages().at(-1)?.text).toContain("следующий шаг");
    expect(error).toHaveBeenCalledWith("Telegram shell typing indicator failed (Error).");
    expect(JSON.stringify(error.mock.calls)).not.toContain("voice_chat");
  });

  it("keeps normal text modality at text", async () => {
    const { spec, telegram } = await connectedDriver();
    await telegram.sendText({ chatId: "voice_chat", userId: "voice_user", text: "Текстовое сообщение" });
    expect(spec.world.events.find((event) => event.type === "ChatMessageReceived")).toMatchObject({ inputModality: "text" });
    expect(spec.world.auditEvents.find((event) => event.type === "chat_received")?.metadata).toEqual({ inputModality: "text" });
  });

  it("applies session and consent guards before the voice-disabled fallback", async () => {
    const spec = createSpecWorld(runner);
    const telegram = new TelegramDriver(spec.world, runner, {}, false);

    await telegram.sendVoice({ chatId: "unknown", fileId: "unknown_voice", durationSeconds: 1 });
    expect(telegram.sentMessages().at(-1)?.text).toBe("Откройте бота по индивидуальной ссылке /start &lt;code&gt;");
    expect(telegram.voiceDownloadCalls()).toEqual([]);

    await onboardTestEmployee(spec);
    await telegram.start({ chatId: "pending", userId: "pending_user", inviteCode: testInvite.inviteCode });
    telegram.clear();
    await telegram.sendVoice({ chatId: "pending", userId: "pending_user", fileId: "unconsented", durationSeconds: 1 });
    expect(telegram.sentMessages().at(-1)).toEqual(expect.objectContaining({
      text: expect.stringContaining("«Минутка» — бот для короткой диагностики рабочих рутин"),
      replyMarkup: expect.objectContaining({
        inlineKeyboard: [[expect.objectContaining({ text: "✅ Принимаю" }), expect.objectContaining({ text: "📄 Подробнее" })]],
      }),
    }));
    expect(telegram.voiceDownloadCalls()).toEqual([]);
  });

  it("disables voice without STT dependencies without downloading the file", async () => {
    const { telegram } = await connectedDriver(false);

    await telegram.sendVoice({ chatId: "voice_chat", userId: "voice_user", fileId: "disabled", durationSeconds: 1 });

    expect(telegram.sentMessages().at(-1)?.text).toBe("Голосовые сообщения сейчас недоступны. Пожалуйста, напишите текстом.");
    expect(telegram.voiceDownloadCalls()).toEqual([]);
  });

  it("rejects unauthorised, unconsented, too-long, and too-large voice before download", async () => {
    const spec = createSpecWorld(runner);
    const telegram = new TelegramDriver(spec.world, runner);
    await telegram.sendVoice({ chatId: "unknown", fileId: "unknown_voice", durationSeconds: 1, transcript: "ignored" });
    expect(telegram.voiceDownloadCalls()).toEqual([]);
    expect(telegram.sentMessages().at(-1)?.text).toBe("Откройте бота по индивидуальной ссылке /start &lt;code&gt;");

    await onboardTestEmployee(spec);
    await telegram.start({ chatId: "pending", userId: "pending_user", inviteCode: testInvite.inviteCode });
    telegram.clear();
    await telegram.sendVoice({ chatId: "pending", userId: "pending_user", fileId: "unconsented", durationSeconds: 1, transcript: "ignored" });
    expect(telegram.voiceDownloadCalls()).toEqual([]);
    expect(telegram.sentMessages().at(-1)).toEqual(expect.objectContaining({
      text: expect.stringContaining("«Минутка» — бот для короткой диагностики рабочих рутин"),
      replyMarkup: expect.objectContaining({
        inlineKeyboard: [[expect.objectContaining({ text: "✅ Принимаю" }), expect.objectContaining({ text: "📄 Подробнее" })]],
      }),
    }));

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

  it("uses Unicode code points consistently from an astral STT transcript through the request contracts", async () => {
    const { spec, telegram } = await connectedDriver();
    const maximumAstralTranscript = "🙂".repeat(maxChatInputCharacters);
    const oversizedAstralTranscript = `${maximumAstralTranscript}🙂`;

    expect(maximumAstralTranscript.length).toBe(maxChatInputCharacters * 2);
    expect(chatRequestSchema.safeParse({ threadId: "voice_chat", text: maximumAstralTranscript, inputModality: "voice" }).success).toBe(true);
    expect(onboardingAnswerRequestSchema.safeParse({ text: maximumAstralTranscript }).success).toBe(true);
    expect(chatRequestSchema.safeParse({ threadId: "voice_chat", text: oversizedAstralTranscript }).success).toBe(false);
    expect(onboardingAnswerRequestSchema.safeParse({ text: oversizedAstralTranscript }).success).toBe(false);

    await telegram.sendVoice({ chatId: "voice_chat", userId: "voice_user", fileId: "astral_limit", durationSeconds: 1, transcript: maximumAstralTranscript });

    expect(spec.world.messages).toContainEqual(expect.objectContaining({ text: maximumAstralTranscript }));
    expect(telegram.sentMessages().map((message) => message.text)).not.toContain("Не удалось обработать голосовое сообщение. Попробуйте ещё раз позже.");
  });

  it("handles download/STT errors, blank and oversized transcripts without chat", async () => {
    const { spec, telegram } = await connectedDriver();
    await telegram.sendVoice({ chatId: "voice_chat", userId: "voice_user", fileId: "download_error", durationSeconds: 1, error: "download" });
    await telegram.sendVoice({ chatId: "voice_chat", userId: "voice_user", fileId: "stt_error", durationSeconds: 1, error: "transcribe" });
    await telegram.sendVoice({ chatId: "voice_chat", userId: "voice_user", fileId: "stream_error", durationSeconds: 1, error: "stream" });
    await telegram.sendVoice({ chatId: "voice_chat", userId: "voice_user", fileId: "empty", durationSeconds: 1, transcript: "   " });
    await telegram.sendVoice({ chatId: "voice_chat", userId: "voice_user", fileId: "oversized", durationSeconds: 1, transcript: "а".repeat(4097) });
    expect(spec.world.messages).toHaveLength(0);
    expect(telegram.closedVoiceStreamIds()).toEqual(expect.arrayContaining(["stt_error", "stream_error"]));
    expect(telegram.sentMessages().map((message) => message.text)).toEqual(expect.arrayContaining([
      "Не удалось обработать голосовое сообщение. Попробуйте ещё раз позже.",
      "Не удалось распознать голосовое сообщение. Попробуйте ещё раз или напишите текстом.",
      "Сообщение слишком длинное (максимум 4096 символов).",
    ]));
  });

  it("times out stalled download and STT, releases the chat guard, and closes the download stream", async () => {
    const spec = createSpecWorld(runner);
    const telegram = new TelegramDriver(spec.world, runner, {}, true, 1);
    await onboardTestEmployee(spec);
    await telegram.start({ chatId: "voice_chat", userId: "voice_user", inviteCode: testInvite.inviteCode });
    const consent = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.clickCallback({ chatId: "voice_chat", userId: "voice_user", callbackData: consent! });
    await telegram.chooseDefaultRole("voice_chat");
    telegram.clear();

    await telegram.sendVoice({ chatId: "voice_chat", userId: "voice_user", fileId: "download-stalled", durationSeconds: 1, error: "download-hang" });
    await telegram.sendVoice({ chatId: "voice_chat", userId: "voice_user", fileId: "stalled", durationSeconds: 1, error: "hang" });
    await telegram.sendText({ chatId: "voice_chat", userId: "voice_user", text: "after timeout" });

    expect(telegram.closedVoiceStreamIds()).toContain("stalled");
    expect(telegram.sentMessages().map((message) => message.text)).toEqual(expect.arrayContaining([
      "Не удалось обработать голосовое сообщение. Попробуйте ещё раз позже.",
      expect.stringContaining("следующий шаг"),
    ]));
  });

  it("does not dispatch a transcript when Telegram cannot show it", async () => {
    const { spec, telegram } = await connectedDriver();
    telegram.failNextMessageDelivery();

    await telegram.sendVoice({ chatId: "voice_chat", userId: "voice_user", fileId: "undelivered_transcript", durationSeconds: 1, transcript: "Текст, который сотрудник не увидел" });

    expect(spec.world.messages).toHaveLength(0);
    expect(telegram.sentMessages().at(-1)?.text).toBe("Не удалось обработать голосовое сообщение. Попробуйте ещё раз позже.");
  });

  it("uses voice transcript for conversational onboarding before profile creation", async () => {
    const spec = createSpecWorld(runner);
    const telegram = new TelegramDriver(spec.world, runner);
    await spec.cli.run(["employee", "issue-invite", "--invite", "voice_onboarding_invite", "--employee", "voice_onboarding_employee"]);
    await telegram.start({ chatId: "onboarding_voice", userId: "onboarding_user", inviteCode: "voice_onboarding_invite" });
    const consent = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.clickCallback({ chatId: "onboarding_voice", userId: "onboarding_user", callbackData: consent! });
    await telegram.chooseDefaultRole("onboarding_voice", "onboarding_user");
    telegram.clear();

    await telegram.sendVoice({ chatId: "onboarding_voice", userId: "onboarding_user", fileId: "onboarding", durationSeconds: 5, transcript: "Максим | Спарк | На ты | Деловой | Коротко | Europe/Moscow" });
    expect(telegram.sentMessages().map((message) => message.text)).toEqual(expect.arrayContaining([
      "Распознано:\nМаксим | Спарк | На ты | Деловой | Коротко | Europe/Moscow",
      expect.stringContaining("Проверьте, пожалуйста"),
    ]));
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
    await telegram.chooseDefaultRole("voice_chat");
    telegram.clear();

    await telegram.sendVoice({ chatId: "voice_chat", userId: "voice_user", fileId: "parallel_voice", durationSeconds: 1, transcript: "first" });
    expect(telegram.sentMessages().map((message) => message.text)).toContain("Пожалуйста, подождите, я ещё отвечаю на предыдущее сообщение.");
    expect(spec.world.messages).toHaveLength(1);
  });
});
