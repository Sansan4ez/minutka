import { describe, expect, it } from "vitest";
import { createSpecWorld, registerSpecMetadata, expectEvent } from "../support/spec-harness.js";
import { TelegramDriver } from "../support/telegram-driver.js";
import { testEmployee, testInvite } from "../support/fixtures.js";
import type { AgentRunner } from "../../../src/application/minutka-service.js";
import { onboardTestEmployee } from "../support/onboarding-helper.js";
import { decodeFeedbackCallbackData } from "../../../src/telegram/callback-data.js";

registerSpecMetadata({
  id: "SPEC-FEEDBACK-001",
  userStory: "US-FEEDBACK-001",
  requirements: ["FR-FEEDBACK-001"],
  productParts: [
    "telegram-bot-shell",
    "ai-agent-backend-runtime",
    "data-storage-and-privacy-layer",
  ],
  contracts: ["telegram-shell", "chat", "submitFeedback"],
  events: [
    "ChatMessageReceived",
    "ChatResponseGenerated",
    "FeedbackReceived",
  ],
  mastra: [],
  cli: [],
});

describe("SPEC-FEEDBACK-001: Telegram feedback and text chat MVP flow", () => {
  const dummyAgentRunner: AgentRunner = async (input, context) => {
    return "Я робот-помощник Минутка.";
  };

  it("1. /start without invite code returns welcome message and does not register session", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);

    await telegram.start({ chatId: "chat_1" });
    
    const sent = telegram.sentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("индивидуальная ссылка с инвайт-кодом");
    expect(spec.world.participants).toHaveLength(0);
  });

  it("2 & 3. Happy path: onboarding, chat, feedback buttons, click callback, and event check", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);

    // Onboard employee first via CLI/API
    await onboardTestEmployee(spec);

    // User starts with invite code
    await telegram.start({ chatId: "chat_1", userId: "user_123", inviteCode: testInvite.inviteCode });

    const sent1 = telegram.sentMessages();
    expect(sent1).toHaveLength(1);
    expect(sent1[0].text).toContain("Минутка хранит"); // privacy/consent explanation
    expect(sent1[0].replyMarkup?.inlineKeyboard[0][0].text).toContain("Принимаю");

    // Click "Consent" button
    const consentCallbackData = sent1[0].replyMarkup?.inlineKeyboard[0][0].callbackData || "";
    expect(consentCallbackData).toContain("tg:consent:");
    
    await telegram.clickCallback({
      chatId: "chat_1",
      userId: "user_123",
      callbackData: consentCallbackData,
    });

    const answers1 = telegram.callbackAnswers();
    expect(answers1).toHaveLength(1);
    expect(answers1[0].text).toBe("Согласие принято!");

    // Send text message after profile completion
    telegram.clear();
    await telegram.sendText({ chatId: "chat_1", userId: "user_123", text: "Сегодня много созвонов." });

    const sent2 = telegram.sentMessages();
    expect(sent2).toHaveLength(1);
    expect(sent2[0].text).toBe("Я робот-помощник Минутка.");
    
    // Check feedback buttons are attached
    const buttons = sent2[0].replyMarkup?.inlineKeyboard[0];
    expect(buttons).toHaveLength(3);
    expect(buttons?.[0].text).toBe("👍");
    expect(buttons?.[1].text).toBe("👌");
    expect(buttons?.[2].text).toBe("👎");

    const positiveCallback = buttons?.[0].callbackData || "";
    expect(positiveCallback.startsWith("fb:p:")).toBe(true);

    // Decode messageId from callback
    const decoded = decodeFeedbackCallbackData(positiveCallback);
    expect(decoded).toBeDefined();
    const targetMessageId = decoded!.targetMessageId;

    // Click feedback 👍
    await telegram.clickFeedback({
      chatId: "chat_1",
      userId: "user_123",
      rating: "positive",
      targetMessageId,
    });

    // Check callback query is answered
    const answers2 = telegram.callbackAnswers();
    expect(answers2).toHaveLength(1);
    expect(answers2[0].text).toBe("Спасибо, учту 👍");

    // Check feedback record is saved in store/world
    expect(spec.world.feedback).toHaveLength(1);
    const fbRecord = spec.world.feedback[0];
    expect(fbRecord.employeeId).toBe(testEmployee.employeeId);
    expect(fbRecord.targetMessageId).toBe(targetMessageId);
    expect(fbRecord.rating).toBe("positive");
    expect(fbRecord.source).toBe("telegram");

    // Check Event is emitted
    expectEvent(spec, {
      type: "FeedbackReceived",
      feedbackId: fbRecord.id,
      employeeId: testEmployee.employeeId,
      threadId: testEmployee.employeeId,
      targetMessageId,
      rating: "positive",
      source: "telegram",
      selectedProcessIds: ["core", "feedback"],
    });

    // Event MUST NOT contain transport details (no chatId, no userId)
    const event = spec.world.events.find((e) => e.type === "FeedbackReceived") as any;
    expect(event.chatId).toBeUndefined();
    expect(event.userId).toBeUndefined();
    expect(event.transport).toBeUndefined();
  });

  it("4. Malformed feedback callback data does not submit feedback", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await onboardTestEmployee(spec);

    // Start session
    await telegram.start({ chatId: "chat_1", inviteCode: testInvite.inviteCode });
    
    // Attempt clicking malformed callback formats
    await telegram.clickCallback({ chatId: "chat_1", callbackData: "fb:x:msg_1" }); // invalid rating code
    await telegram.clickCallback({ chatId: "chat_1", callbackData: "fb:p:" }); // empty messageId
    await telegram.clickCallback({ chatId: "chat_1", callbackData: "fb:p:msg 1" }); // space in messageId
    await telegram.clickCallback({ chatId: "chat_1", callbackData: "fb:p:msg:1" }); // colon in messageId
    await telegram.clickCallback({ chatId: "chat_1", callbackData: `fb:p:${"a".repeat(60)}` }); // targetMessageId too long (>50)
    await telegram.clickCallback({ chatId: "chat_1", callbackData: "unknown_prefix" }); // unknown prefix

    expect(spec.world.feedback).toHaveLength(0);
    // Callback query answers should indicate error
    expect(telegram.callbackAnswers().map((a) => a.text)).toContain("Неверный формат отзыва.");
  });

  it("5. Feedback callback on non-existent or other employee's targetMessageId does not save feedback", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await onboardTestEmployee(spec);

    await telegram.start({ chatId: "chat_1", inviteCode: testInvite.inviteCode });
    
    // Message id doesn't exist in the database yet
    await telegram.clickFeedback({ chatId: "chat_1", rating: "positive", targetMessageId: "msg_nonexistent" });
    expect(spec.world.feedback).toHaveLength(0);

    const answers = telegram.callbackAnswers();
    expect(answers[0].text).toContain("Ошибка"); // Error message caught and sent back
  });

  it("6. Repeated feedback callback on the same targetMessageId does not create duplicate (upserts rating)", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await onboardTestEmployee(spec);

    await telegram.start({ chatId: "chat_1", inviteCode: testInvite.inviteCode });
    telegram.clear();
    await telegram.sendText({ chatId: "chat_1", text: "Какая сегодня погода?" });

    const sent = telegram.sentMessages();
    const buttons = sent[0].replyMarkup?.inlineKeyboard[0];
    const targetMessageId = decodeFeedbackCallbackData(buttons![0].callbackData)!.targetMessageId;

    // First feedback click: positive
    await telegram.clickFeedback({ chatId: "chat_1", rating: "positive", targetMessageId });
    expect(spec.world.feedback).toHaveLength(1);
    expect(spec.world.feedback[0].rating).toBe("positive");

    // Second feedback click: negative
    await telegram.clickFeedback({ chatId: "chat_1", rating: "negative", targetMessageId });
    // Should still have length 1, but updated rating
    expect(spec.world.feedback).toHaveLength(1);
    expect(spec.world.feedback[0].rating).toBe("negative");
  });

  it("7 & 8. Repeated /start for already linked chat / different invite behavior", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await onboardTestEmployee(spec);

    // Initial start
    await telegram.start({ chatId: "chat_1", inviteCode: testInvite.inviteCode });
    
    // Repeated /start with same invite
    telegram.clear();
    await telegram.start({ chatId: "chat_1", inviteCode: testInvite.inviteCode });
    expect(telegram.sentMessages()[0].text).toContain("Вы уже зарегистрированы");

    // Repeated /start with different invite should not link or overwrite
    telegram.clear();
    await telegram.start({ chatId: "chat_1", inviteCode: "invite_another" });
    expect(telegram.sentMessages()[0].text).toContain("Смена привязки не поддерживается");

    // Repeated /start without parameters
    telegram.clear();
    await telegram.start({ chatId: "chat_1" });
    expect(telegram.sentMessages()[0].text).toContain("Вы уже зарегистрированы");
  });

  it("9. tg:consent checks that session.employeeId === employeeId", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);

    await telegram.start({ chatId: "chat_1", inviteCode: testInvite.inviteCode });
    
    // Attempt clicking consent callback with mismatching employeeId
    telegram.clear();
    await telegram.clickCallback({ chatId: "chat_1", callbackData: "tg:consent:emp_mismatch" });
    expect(telegram.callbackAnswers()[0].text).toBe("Неверная сессия.");
  });

  it("10. Text message without completed profile doesn't call client.chat() and requests to complete onboarding/profile", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);

    // Start with invite but do not complete onboarding/profile
    await telegram.start({ chatId: "chat_1", inviteCode: "invite_uncompleted" });
    
    // Accept consent
    await telegram.clickCallback({ chatId: "chat_1", callbackData: "tg:consent:emp_1" });
    
    // Send text
    telegram.clear();
    await telegram.sendText({ chatId: "chat_1", text: "Привет" });
    expect(telegram.sentMessages()[0].text).toContain("Сначала завершите onboarding");
  });

  it("12 & 13. Edge checks: empty, oversized, concurrent chat messages", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await onboardTestEmployee(spec);
    await telegram.start({ chatId: "chat_1", inviteCode: testInvite.inviteCode });

    // Empty text
    telegram.clear();
    await telegram.sendText({ chatId: "chat_1", text: "   " });
    expect(telegram.sentMessages()[0].text).toContain("не может быть пустым");

    // Oversized text (> 4096 characters)
    telegram.clear();
    await telegram.sendText({ chatId: "chat_1", text: "a".repeat(4097) });
    expect(telegram.sentMessages()[0].text).toContain("слишком длинное");

    // Concurrent check / in-flight protection:
    let callCounter = 0;
    const concurrentAgentRunner: AgentRunner = async (input, context) => {
      callCounter++;
      // While this runner is active, trigger another text handler call
      await telegram2.sendText({ chatId: "chat_1", text: "Второе сообщение во время обработки" });
      return "Ответ на первое";
    };

    const spec2 = createSpecWorld(concurrentAgentRunner);
    const telegram2 = new TelegramDriver(spec2.world, concurrentAgentRunner);
    await onboardTestEmployee(spec2);
    // Reset call counter after onboarding since onboarding also triggers agentRunner
    callCounter = 0;
    await telegram2.start({ chatId: "chat_1", inviteCode: testInvite.inviteCode });

    telegram2.clear();
    await telegram2.sendText({ chatId: "chat_1", text: "Первое сообщение" });

    expect(callCounter).toBe(1);
    
    const sentMessages = telegram2.sentMessages();
    const texts = sentMessages.map(m => m.text);
    expect(texts).toContain("Пожалуйста, подождите, я ещё отвечаю на предыдущее сообщение.");
  });
});
