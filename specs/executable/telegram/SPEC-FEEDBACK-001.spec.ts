import { describe, expect, it } from "vitest";
import { createSpecWorld, registerSpecMetadata, expectEvent } from "../support/spec-harness.js";
import { TelegramDriver } from "../support/telegram-driver.js";
import { testEmployee, testInvite } from "../support/fixtures.js";
import type { AgentRunner } from "../../../src/application/minutka-service.js";
import { onboardTestEmployee } from "../support/onboarding-helper.js";
import { decodeFeedbackCallbackData } from "../../../src/telegram/callback-data.js";
import { parseInviteSeeds } from "../../../src/telegram/invite-seeds.js";
import { privacyExplanation } from "../../../src/domain/privacy.js";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import { ServiceMinutkaClient } from "../../../src/client/sdk/minutka-client.js";
import { createInProcessServiceTransport } from "../../../src/server/http/in-process-transport.js";
import { createTelegramShell } from "../../../src/telegram/telegram-shell.js";

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

  it("0. Invite bootstrap parser accepts unique employeeId:inviteCode pairs only", () => {
    expect(parseInviteSeeds("emp_1:invite_a,emp_2:invite_b")).toEqual([
      { employeeId: "emp_1", inviteCode: "invite_a" },
      { employeeId: "emp_2", inviteCode: "invite_b" },
    ]);
    expect(() => parseInviteSeeds("emp_1:invite_a,emp_1:invite_b")).toThrow(/duplicate employeeIds/);
    expect(() => parseInviteSeeds("emp_1:invite_a,emp_2:invite_a")).toThrow(/duplicate inviteCodes/);
    expect(() => parseInviteSeeds("not-a-pair")).toThrow(/employeeId:inviteCode/);
  });

  it("1. /start without invite code returns welcome message and does not register session", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);

    await telegram.start({ chatId: "chat_1" });

    const sent = telegram.sentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("индивидуальная ссылка с инвайт-кодом");
    expect(spec.world.participants).toHaveLength(0);
  });

  it("1b. Unknown deep-link invite cannot create a participant or session", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);

    await telegram.start({
      chatId: "intruder_chat",
      userId: "intruder_456",
      inviteCode: "made_up_invite",
    });

    expect(spec.world.participants).toHaveLength(0);
    expect(telegram.sentMessages()).toEqual([
      expect.objectContaining({ text: expect.stringContaining("ссылка недействительна") }),
    ]);
  });

  it("1bb. Issuing an existing invite is idempotent for its original employee", async () => {
    const spec = createSpecWorld(dummyAgentRunner);

    const first = await spec.cli.json<{ created: boolean; status: string }>([
      "employee",
      "issue-invite",
      "--invite",
      "invite_idempotent",
      "--employee",
      "emp_idempotent",
    ]);
    const repeated = await spec.cli.json<{ created: boolean; status: string }>([
      "employee",
      "issue-invite",
      "--invite",
      "invite_idempotent",
      "--employee",
      "emp_idempotent",
    ]);

    expect(first).toMatchObject({ created: true, status: "invite_issued" });
    expect(repeated).toMatchObject({ created: false, status: "invite_issued" });
    expect(spec.world.participants).toHaveLength(1);
  });

  it("1bc. An employee cannot have more than one active invite", async () => {
    const spec = createSpecWorld(dummyAgentRunner);

    await spec.cli.json([
      "employee",
      "issue-invite",
      "--invite",
      "invite_primary",
      "--employee",
      "emp_single_invite",
    ]);

    await expect(
      spec.cli.json([
        "employee",
        "issue-invite",
        "--invite",
        "invite_secondary",
        "--employee",
        "emp_single_invite",
      ]),
    ).rejects.toThrow(/employee already has an active invite/);

    expect(spec.world.participants).toEqual([
      expect.objectContaining({ employeeId: "emp_single_invite" }),
    ]);
    expect(JSON.stringify(spec.world.participants)).not.toContain("invite_primary");
  });

  it("1c. Concurrent /start calls can claim a pre-issued invite only once", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await spec.cli.json([
      "employee",
      "issue-invite",
      "--invite",
      "invite_parallel",
      "--employee",
      "emp_parallel",
    ]);

    await Promise.all([
      telegram.start({
        chatId: "owner_chat",
        userId: "owner_123",
        inviteCode: "invite_parallel",
      }),
      telegram.start({
        chatId: "intruder_chat",
        userId: "intruder_456",
        inviteCode: "invite_parallel",
      }),
    ]);

    expect(spec.world.participants).toHaveLength(1);
    expect(
      telegram.sentMessages().filter((message) => message.replyMarkup),
    ).toHaveLength(1);
    expect(telegram.sentMessages()).toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining("уже привязана к другому Telegram-аккаунту"),
      }),
    );
  });

  it("1d. A conflicting session claim does not consume the invite", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await spec.cli.json([
      "employee",
      "issue-invite",
      "--invite",
      "invite_unconsumed",
      "--employee",
      "emp_unconsumed",
    ]);

    // Occupy the chat with another employee, then try the target invite.
    await spec.cli.json([
      "employee",
      "issue-invite",
      "--invite",
      "invite_other",
      "--employee",
      "emp_other",
    ]);
    await telegram.start({ chatId: "shared_chat", userId: "user_a", inviteCode: "invite_other" });
    await telegram.start({ chatId: "shared_chat", userId: "user_b", inviteCode: "invite_unconsumed" });

    expect(spec.world.participants).toContainEqual(
      expect.objectContaining({ employeeId: "emp_unconsumed", status: "invite_issued" }),
    );
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
    expect(sent1[0].text).toBe(privacyExplanation);
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
    });

    const auditEvent = spec.world.auditEvents.find((event) => event.type === "feedback_received");
    expect(auditEvent?.metadata).toEqual({ feedbackId: fbRecord.id, rating: "positive", source: "telegram" });

    // Event MUST NOT contain transport details (no chatId, no userId)
    const event = spec.world.events.find((e) => e.type === "FeedbackReceived") as any;
    expect(event.chatId).toBeUndefined();
    expect(event.userId).toBeUndefined();
    expect(event.transport).toBeUndefined();
  });

  it("3a. Shows Telegram typing while a normal chat response is being generated", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await onboardTestEmployee(spec);
    await telegram.start({ chatId: "typing_chat", userId: "typing_user", inviteCode: testInvite.inviteCode });
    const consentCallbackData = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.clickCallback({ chatId: "typing_chat", userId: "typing_user", callbackData: consentCallbackData! });
    telegram.clear();

    await telegram.sendText({ chatId: "typing_chat", userId: "typing_user", text: "Помоги с приоритетами." });

    expect(telegram.sentChatActions()).toEqual([{ chatId: "typing_chat", action: "typing" }]);
  });

  it("3b. Consent callback gates chat and feedback even for an already onboarded employee", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await onboardTestEmployee(spec);

    await telegram.start({
      chatId: "chat_1",
      userId: "user_123",
      inviteCode: testInvite.inviteCode,
    });
    telegram.clear();

    await telegram.sendText({
      chatId: "chat_1",
      userId: "user_123",
      text: "Покажи мой контекст.",
    });
    expect(telegram.sentMessages()).toEqual([
      expect.objectContaining({
        text: "Сначала подтвердите согласие с политикой конфиденциальности.",
      }),
    ]);
    expect(spec.world.messages).toHaveLength(0);

    telegram.clear();
    await telegram.clickFeedback({
      chatId: "chat_1",
      userId: "user_123",
      rating: "positive",
      targetMessageId: "msg_1",
    });
    expect(telegram.callbackAnswers()).toEqual([
      expect.objectContaining({
        text: "Сначала подтвердите согласие с политикой конфиденциальности.",
      }),
    ]);
    expect(spec.world.feedback).toHaveLength(0);
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
    const consentCallbackData = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0]
      .callbackData;
    await telegram.clickCallback({ chatId: "chat_1", callbackData: consentCallbackData! });
    telegram.clear();

    // Message id doesn't exist in the database yet
    await telegram.clickFeedback({ chatId: "chat_1", rating: "positive", targetMessageId: "msg_nonexistent" });
    expect(spec.world.feedback).toHaveLength(0);

    const answers = telegram.callbackAnswers();
    expect(answers[0].text).toBe("Не удалось сохранить отзыв. Попробуйте ещё раз позже.");

    const otherEmployeeId = "emp_other";
    const otherThreadId = "thread_other";
    await spec.cli.json([
      "employee",
      "open-invite",
      "--invite",
      "invite_other",
      "--employee",
      otherEmployeeId,
    ]);
    await spec.cli.json([
      "employee",
      "accept-consent",
      "--employee",
      otherEmployeeId,
      "--yes",
    ]);
    await spec.cli.json([
      "employee",
      "complete-onboarding",
      "--employee",
      otherEmployeeId,
      "--role",
      "Аналитик",
      "--task",
      "Отчёты",
      "--persona",
      "support",
      "--ai-level",
      "beginner",
    ]);
    const otherChat = await spec.cli.json<{ messageId: string }>([
      "employee",
      "chat",
      "--employee",
      otherEmployeeId,
      "--thread",
      otherThreadId,
      "--text",
      "Сообщение другого сотрудника",
    ]);

    await telegram.clickFeedback({
      chatId: "chat_1",
      rating: "positive",
      targetMessageId: otherChat.messageId,
    });

    expect(spec.world.feedback).toHaveLength(0);
    expect(telegram.callbackAnswers().at(-1)?.text).toBe(
      "Не удалось сохранить отзыв. Попробуйте ещё раз позже.",
    );
  });

  it("6. Repeated feedback callback from the same action message is acknowledged without a duplicate side effect", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await onboardTestEmployee(spec);

    await telegram.start({ chatId: "chat_1", inviteCode: testInvite.inviteCode });
    const consentCallbackData = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0]
      .callbackData;
    await telegram.clickCallback({ chatId: "chat_1", callbackData: consentCallbackData! });
    telegram.clear();
    await telegram.sendText({ chatId: "chat_1", text: "Какая сегодня погода?" });

    const sent = telegram.sentMessages();
    const buttons = sent[0].replyMarkup?.inlineKeyboard[0];
    const targetMessageId = decodeFeedbackCallbackData(buttons![0].callbackData)!.targetMessageId;

    // First feedback click: positive
    await telegram.clickFeedback({ chatId: "chat_1", rating: "positive", targetMessageId });
    expect(spec.world.feedback).toHaveLength(1);
    expect(spec.world.feedback[0].rating).toBe("positive");

    // A stale second callback from the same Telegram message is ignored.
    await telegram.clickFeedback({ chatId: "chat_1", rating: "negative", targetMessageId, messageId: sent[0].messageId });
    expect(spec.world.feedback).toHaveLength(1);
    expect(spec.world.feedback[0].rating).toBe("positive");
    expect(telegram.callbackAnswers().at(-1)?.text).toBe("Уже обработано.");
  });

  it("6b. Removes action keyboards after callbacks, on the next message, and keeps domain success when cleanup fails", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await onboardTestEmployee(spec);
    await telegram.start({ chatId: "chat_cleanup", inviteCode: testInvite.inviteCode });
    const consentMessage = telegram.sentMessages()[0];
    const consentCallback = consentMessage.replyMarkup?.inlineKeyboard[0][0].callbackData;

    await telegram.clickCallback({ chatId: "chat_cleanup", callbackData: consentCallback!, messageId: consentMessage.messageId });
    expect(telegram.replyMarkupEditCalls()).toContainEqual({ chatId: "chat_cleanup", messageId: consentMessage.messageId, replyMarkup: undefined });

    telegram.clear();
    await telegram.sendText({ chatId: "chat_cleanup", text: "Первый вопрос" });
    const feedbackMessage = telegram.sentMessages()[0];
    telegram.clear();
    await telegram.sendText({ chatId: "chat_cleanup", text: "Следующий вопрос" });
    expect(telegram.replyMarkupEditCalls()).toContainEqual({ chatId: "chat_cleanup", messageId: feedbackMessage.messageId, replyMarkup: undefined });

    const latest = telegram.sentMessages().at(-1)!;
    const callback = latest.replyMarkup?.inlineKeyboard[0][0].callbackData;
    const targetMessageId = decodeFeedbackCallbackData(callback!)!.targetMessageId;
    telegram.failNextReplyMarkupEdit();
    await telegram.clickFeedback({ chatId: "chat_cleanup", rating: "positive", targetMessageId, messageId: latest.messageId });
    expect(spec.world.feedback).toContainEqual(expect.objectContaining({ targetMessageId, rating: "positive" }));
    expect(telegram.callbackAnswers().at(-1)?.text).toBe("Спасибо, учту 👍");
  });

  it("7 & 8. Repeated /start for already linked chat / different invite behavior", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await onboardTestEmployee(spec);

    // Initial start
    await telegram.start({ chatId: "chat_1", inviteCode: testInvite.inviteCode });
    const consentCallbackData = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.clickCallback({ chatId: "chat_1", callbackData: consentCallbackData! });

    // Repeated /start with same invite
    telegram.clear();
    await telegram.start({ chatId: "chat_1", inviteCode: testInvite.inviteCode });
    expect(telegram.sentMessages()[0].text).toContain("Вы уже зарегистрированы");

    // Repeated /start with different invite should not link or overwrite
    telegram.clear();
    await telegram.start({ chatId: "chat_1", inviteCode: "invite_another" });
    expect(telegram.sentMessages()[0].text).toContain("Вы уже зарегистрированы");

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

  it("10. A clean Telegram runtime can complete minimal onboarding and then chat", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await spec.cli.json([
      "employee",
      "issue-invite",
      "--invite",
      "invite_uncompleted",
      "--employee",
      "emp_uncompleted",
    ]);

    await telegram.start({ chatId: "chat_1", inviteCode: "invite_uncompleted" });
    const consentCallback = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    expect(consentCallback).toBe("tg:consent:emp_uncompleted");
    await telegram.clickCallback({ chatId: "chat_1", callbackData: consentCallback! });

    telegram.clear();
    await telegram.sendText({ chatId: "chat_1", text: "Привет" });
    expect(telegram.sentMessages()[0].text).toContain("называть меня");
    expect(spec.world.messages).toHaveLength(0);

    telegram.clear();
    await telegram.sendText({
      chatId: "chat_1",
      text: "Максим | Спарк | На ты | Деловой | Коротко | Europe/Moscow",
    });
    expect(telegram.sentMessages()[0].text).toContain("Проверьте, пожалуйста");
    expect(spec.world.profiles).toHaveLength(0);

    const confirm = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.clickCallback({ chatId: "chat_1", callbackData: confirm! });
    expect(telegram.sentMessages().at(-1)?.text).toBe("Я робот-помощник Минутка.");
    expect(spec.world.profiles).toHaveLength(1);

    telegram.clear();
    await telegram.sendText({ chatId: "chat_1", text: "Сегодня много созвонов." });
    expect(telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0]).toHaveLength(3);
  });

  it("10a. Keeps repeated confirmation input responsive and concurrent confirm callbacks idempotent", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await spec.cli.run(["employee", "issue-invite", "--invite", "invite_confirmation_dedupe", "--employee", "emp_confirmation_dedupe"]);
    await telegram.start({ chatId: "chat_confirmation_dedupe", inviteCode: "invite_confirmation_dedupe" });
    const consent = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.clickCallback({ chatId: "chat_confirmation_dedupe", callbackData: consent! });
    telegram.clear();

    const completeAnswer = "Максим | Спарк | На ты | Деловой | Коротко | Europe/Moscow";
    await telegram.deliverText({ chatId: "chat_confirmation_dedupe", text: completeAnswer });
    await telegram.deliverText({ chatId: "chat_confirmation_dedupe", text: completeAnswer });

    const confirmations = telegram.sentMessages().filter((message) => message.text.includes("Проверьте, пожалуйста"));
    expect(confirmations).toHaveLength(1);
    expect(telegram.sentMessages()).toContainEqual(expect.objectContaining({ text: expect.stringContaining("Анкета уже готова к подтверждению") }));
    const confirmation = confirmations[0];
    const confirm = confirmation.replyMarkup?.inlineKeyboard[0][0].callbackData;
    telegram.clear();

    await Promise.all([
      telegram.deliverCallback({ chatId: "chat_confirmation_dedupe", callbackData: confirm!, messageId: confirmation.messageId, callbackQueryId: "confirm_a" }),
      telegram.deliverCallback({ chatId: "chat_confirmation_dedupe", callbackData: confirm!, messageId: confirmation.messageId, callbackQueryId: "confirm_b" }),
    ]);

    expect(spec.world.profiles).toHaveLength(1);
    expect(telegram.sentMessages().filter((message) => message.text === "Я робот-помощник Минутка.")).toHaveLength(1);
  });

  it("10aa. Retries the same confirmation revision after Telegram delivery fails", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await spec.cli.run(["employee", "issue-invite", "--invite", "invite_confirmation_retry", "--employee", "emp_confirmation_retry"]);
    await telegram.start({ chatId: "chat_confirmation_retry", inviteCode: "invite_confirmation_retry" });
    const consent = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.clickCallback({ chatId: "chat_confirmation_retry", callbackData: consent! });
    telegram.clear();

    const completeAnswer = "Максим | Спарк | На ты | Деловой | Коротко | Europe/Moscow";
    telegram.failNextMessageDelivery();
    await telegram.deliverText({ chatId: "chat_confirmation_retry", text: completeAnswer });
    telegram.clear();
    await telegram.deliverText({ chatId: "chat_confirmation_retry", text: completeAnswer });

    expect(telegram.sentMessages().filter((message) => message.text.includes("Проверьте, пожалуйста"))).toHaveLength(1);
  });

  it("10ab. A stale confirmation callback reports the saved profile without another greeting", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await spec.cli.run(["employee", "issue-invite", "--invite", "invite_stale_confirmation", "--employee", "emp_stale_confirmation"]);
    await telegram.start({ chatId: "chat_stale_confirmation", inviteCode: "invite_stale_confirmation" });
    const consent = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.clickCallback({ chatId: "chat_stale_confirmation", callbackData: consent! });
    telegram.clear();
    await telegram.sendText({ chatId: "chat_stale_confirmation", text: "Максим | Спарк | На ты | Деловой | Коротко | Europe/Moscow" });
    const confirmation = telegram.sentMessages()[0];
    const confirm = confirmation.replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.deliverCallback({ chatId: "chat_stale_confirmation", callbackData: confirm!, messageId: confirmation.messageId, callbackQueryId: "confirm_first" });
    telegram.clear();

    await telegram.deliverCallback({ chatId: "chat_stale_confirmation", callbackData: confirm!, messageId: confirmation.messageId, callbackQueryId: "confirm_stale" });

    expect(telegram.callbackAnswers()).toContainEqual({ callbackQueryId: "confirm_stale", text: "Профиль уже сохранён." });
    expect(telegram.sentMessages()).toHaveLength(0);
  });

  it("10ac. Keeps stale consent keyboards idempotent after the Telegram shell restarts", async () => {
    const world = createSpecWorld(dummyAgentRunner).world;
    const runtime = createInMemoryRuntime({ world, agentRunner: dummyAgentRunner });
    await runtime.service.issueInvite({ employeeId: "emp_consent_restart", inviteCode: "invite_consent_restart" });
    const firstShell = new TelegramDriver(world, dummyAgentRunner, {}, true, undefined, runtime);
    await firstShell.start({ chatId: "chat_consent_restart", inviteCode: "invite_consent_restart" });
    const prompt = firstShell.sentMessages()[0];
    const consent = prompt.replyMarkup?.inlineKeyboard[0][0].callbackData;
    await firstShell.deliverCallback({ chatId: "chat_consent_restart", callbackData: consent!, messageId: prompt.messageId, callbackQueryId: "consent_first" });

    const restartedShell = new TelegramDriver(world, dummyAgentRunner, {}, true, undefined, runtime);
    await restartedShell.deliverCallback({ chatId: "chat_consent_restart", callbackData: consent!, messageId: prompt.messageId, callbackQueryId: "consent_stale" });

    expect(restartedShell.callbackAnswers()).toContainEqual({ callbackQueryId: "consent_stale", text: "Уже обработано." });
    expect(restartedShell.sentMessages()).toHaveLength(0);
    expect(world.auditEvents.filter((event) => event.type === "consent_accepted")).toHaveLength(1);
  });

  it("10ad. Retries a double-click when the first callback attempt fails", async () => {
    const world = createSpecWorld(dummyAgentRunner).world;
    let attempts = 0;
    let startFirstAttempt!: () => void;
    let rejectFirstAttempt!: () => void;
    const firstAttemptStarted = new Promise<void>((resolve) => { startFirstAttempt = resolve; });
    const firstAttemptFailure = new Promise<never>((_, reject) => { rejectFirstAttempt = () => reject(new Error("temporary context failure")); });
    const runtime = createInMemoryRuntime({
      world,
      agentRunner: dummyAgentRunner,
      deps: {
        onboardingContextMaterializer: {
          async materialize() {
            attempts += 1;
            if (attempts === 1) { startFirstAttempt(); return await firstAttemptFailure; }
            return [];
          },
        },
      },
    });
    await runtime.service.issueInvite({ employeeId: "emp_confirm_retry", inviteCode: "invite_confirm_retry" });
    const telegram = new TelegramDriver(world, dummyAgentRunner, {}, true, undefined, runtime);
    await telegram.start({ chatId: "chat_confirm_retry", inviteCode: "invite_confirm_retry" });
    const consent = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.clickCallback({ chatId: "chat_confirm_retry", callbackData: consent! });
    telegram.clear();
    await telegram.sendText({ chatId: "chat_confirm_retry", text: "Максим | Спарк | На ты | Деловой | Коротко | Europe/Moscow" });
    const confirmation = telegram.sentMessages()[0];
    const confirm = confirmation.replyMarkup?.inlineKeyboard[0][0].callbackData;

    const first = telegram.deliverCallback({ chatId: "chat_confirm_retry", callbackData: confirm!, messageId: confirmation.messageId, callbackQueryId: "confirm_failing" });
    await firstAttemptStarted;
    const second = telegram.deliverCallback({ chatId: "chat_confirm_retry", callbackData: confirm!, messageId: confirmation.messageId, callbackQueryId: "confirm_retry" });
    rejectFirstAttempt();
    await Promise.all([first, second]);

    expect(attempts).toBe(2);
    expect(world.profiles).toHaveLength(1);
    expect(telegram.callbackAnswers()).toContainEqual({ callbackQueryId: "confirm_failing", text: "Не удалось сохранить профиль. Попробуйте ещё раз позже." });
    expect(telegram.callbackAnswers()).toContainEqual({ callbackQueryId: "confirm_retry", text: "Профиль сохранён!" });
    expect(telegram.callbackAnswers()).not.toContainEqual({ callbackQueryId: "confirm_retry", text: "Профиль уже сохранён." });
  });

  it("10a. Lets the employee correct a summary through the edit callback and textual confirmation", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await spec.cli.run(["employee", "issue-invite", "--invite", "invite_correction", "--employee", "emp_correction"]);
    await telegram.start({ chatId: "chat_correction", inviteCode: "invite_correction" });
    const consent = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.clickCallback({ chatId: "chat_correction", callbackData: consent! });
    telegram.clear();
    await telegram.sendText({ chatId: "chat_correction", text: "Максим | Спарк | На ты | Деловой | Коротко | Europe/Moscow" });
    const edit = telegram.sentMessages().at(-1)?.replyMarkup?.inlineKeyboard[0][1];
    expect(edit).toMatchObject({ text: "✏️ Исправить", callbackData: "ob:reset" });
    await telegram.clickCallback({ chatId: "chat_correction", callbackData: edit!.callbackData });
    expect(telegram.sentMessages().at(-1)?.text).toContain("Напишите, что исправить");
    telegram.clear();
    await telegram.sendText({ chatId: "chat_correction", text: "Зови меня Алексей" });
    expect(telegram.sentMessages().at(-1)?.text).toContain("Алексей");
    telegram.clear();
    await telegram.sendText({ chatId: "chat_correction", text: "Да" });
    expect(spec.world.profiles[0]).toMatchObject({ preferredName: "Алексей", assistantName: "Спарк", timezone: "Europe/Moscow" });
  });

  it("10b. Uses canonical callback values for the response-length choice", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner, { onboardingProfileExtractor: async () => { throw new Error("unavailable"); } });
    await spec.cli.run(["employee", "issue-invite", "--invite", "invite_ai_button", "--employee", "emp_ai_button"]);
    await telegram.start({ chatId: "chat_ai_button", inviteCode: "invite_ai_button" });
    const consent = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.clickCallback({ chatId: "chat_ai_button", callbackData: consent! });
    telegram.clear();
    await telegram.sendText({ chatId: "chat_ai_button", text: "Меня зовут Максим. Тебя зовут Спарк. Общаемся на ты, стиль деловой." });
    const short = telegram.sentMessages().at(-1)?.replyMarkup?.inlineKeyboard[0][0];
    expect(short).toMatchObject({ text: "Коротко", callbackData: "ob:responseLength:short" });
    await telegram.clickCallback({ chatId: "chat_ai_button", callbackData: short!.callbackData });
    expect(telegram.sentMessages().at(-1)?.text).toContain("часовой пояс");
  });

  it("10ba. Serializes onboarding callbacks with concurrent text deliveries", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner, { onboardingProfileExtractor: async () => { throw new Error("unavailable"); } });
    await spec.cli.run(["employee", "issue-invite", "--invite", "invite_callback_text_race", "--employee", "emp_callback_text_race"]);
    await telegram.start({ chatId: "chat_callback_text_race", inviteCode: "invite_callback_text_race" });
    const consent = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.clickCallback({ chatId: "chat_callback_text_race", callbackData: consent! });
    telegram.clear();

    await telegram.sendText({ chatId: "chat_callback_text_race", text: "Меня зовут Максим. Тебя зовут Спарк." });
    const choiceMessage = telegram.sentMessages().at(-1)!;
    const informal = choiceMessage.replyMarkup?.inlineKeyboard[0][0];
    expect(informal).toMatchObject({ text: "На ты", callbackData: "ob:addressForm:informal" });
    telegram.clear();

    await Promise.all([
      telegram.deliverCallback({ chatId: "chat_callback_text_race", callbackData: informal!.callbackData, messageId: choiceMessage.messageId, callbackQueryId: "choice_race" }),
      telegram.deliverText({ chatId: "chat_callback_text_race", text: "Деловой" }),
    ]);

    expect(telegram.callbackAnswers()).toContainEqual({ callbackQueryId: "choice_race", text: undefined });
    expect(telegram.sentMessages().filter((message) => message.text.includes("стиль общения"))).toHaveLength(1);
    expect(telegram.sentMessages()).toContainEqual(expect.objectContaining({ text: "Пожалуйста, подождите, я ещё отвечаю на предыдущее сообщение." }));
    expect(telegram.replyMarkupEditCalls()).toContainEqual({ chatId: "chat_callback_text_race", messageId: choiceMessage.messageId, replyMarkup: undefined });
  });

  it("10b. Repeated consent callback is idempotent under concurrent delivery", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await spec.cli.json([
      "employee",
      "issue-invite",
      "--invite",
      "invite_consent_parallel",
      "--employee",
      "emp_consent_parallel",
    ]);
    await telegram.start({ chatId: "chat_1", inviteCode: "invite_consent_parallel" });
    const callbackData = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    expect(callbackData).toBe("tg:consent:emp_consent_parallel");

    await Promise.all([
      telegram.clickCallback({ chatId: "chat_1", callbackData: callbackData! }),
      telegram.clickCallback({ chatId: "chat_1", callbackData: callbackData! }),
    ]);

    expect(spec.world.consents).toHaveLength(1);
    expect(spec.world.events.filter((event) => event.type === "ConsentAccepted")).toHaveLength(1);
  });

  it("10c. Repeating /start resumes consent after the first delivery fails", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await spec.cli.json([
      "employee",
      "issue-invite",
      "--invite",
      "invite_retry",
      "--employee",
      "emp_retry",
    ]);

    telegram.failNextMessageDelivery();
    await telegram.start({ chatId: "chat_1", inviteCode: "invite_retry" });
    telegram.clear();

    await telegram.start({ chatId: "chat_1", inviteCode: "invite_retry" });
    expect(telegram.sentMessages()).toEqual([
      expect.objectContaining({
        text: privacyExplanation,
        replyMarkup: expect.objectContaining({
          inlineKeyboard: [[expect.objectContaining({ callbackData: "tg:consent:emp_retry" })]],
        }),
      }),
    ]);
    expect(
      spec.world.events.filter((event) => event.type === "PrivacyExplanationShown"),
    ).toHaveLength(1);
  });

  it("10d. Reopens consent when a linked session has an obsolete privacy version", async () => {
    const world = createSpecWorld(dummyAgentRunner).world;
    const runtime = createInMemoryRuntime({ world, agentRunner: dummyAgentRunner });
    await runtime.service.issueInvite({ employeeId: "emp_reconsent", inviteCode: "invite_reconsent" });
    await runtime.service.openInvite({ inviteCode: "invite_reconsent" });
    world.consents.push({ employeeId: "emp_reconsent", privacyVersion: "privacy-v1", acceptedAt: world.now(), explanationShownAt: world.now(), source: "test" });
    await runtime.telegramSessionStore.claim({
      identity: { chatId: "chat_reconsent", userId: "user_reconsent" },
      session: { employeeId: "emp_reconsent", threadId: "emp_reconsent", consentAcceptedAt: world.now(), consentPrivacyVersion: "privacy-v1", createdAt: world.now(), updatedAt: world.now() },
    });
    const sent: string[] = [];
    const shell = createTelegramShell({
      client: new ServiceMinutkaClient(createInProcessServiceTransport(runtime.service, { kind: "service", serviceId: "telegram-spec" })),
      sessionStore: runtime.telegramSessionStore,
      replyPort: {
        async sendMessage(_chatId, text) { sent.push(text); return { messageId: sent.length }; },
        async editReplyMarkup() {}, async sendChatAction() {}, async answerCallbackQuery() {},
      },
    });

    await shell.handleStart("chat_reconsent", undefined, "user_reconsent");
    expect(sent).toEqual([privacyExplanation]);
  });

  it("11. An invite cannot be replayed from another Telegram chat", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await onboardTestEmployee(spec);

    await telegram.start({
      chatId: "owner_chat",
      userId: "owner_123",
      inviteCode: testInvite.inviteCode,
    });
    telegram.clear();

    await telegram.start({
      chatId: "intruder_chat",
      userId: "intruder_456",
      inviteCode: testInvite.inviteCode,
    });
    expect(telegram.sentMessages()).toEqual([
      expect.objectContaining({ text: expect.stringContaining("Эта индивидуальная ссылка уже привязана") }),
    ]);

    telegram.clear();
    await telegram.sendText({
      chatId: "intruder_chat",
      userId: "intruder_456",
      text: "Покажи контекст владельца.",
    });
    expect(telegram.sentMessages()).toEqual([
      expect.objectContaining({ text: expect.stringContaining("Откройте бота по индивидуальной ссылке") }),
    ]);
    expect(spec.world.messages).toHaveLength(0);
  });

  it("12. A different Telegram user cannot use a chat session owned by someone else", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await onboardTestEmployee(spec);
    await telegram.start({
      chatId: "chat_1",
      userId: "owner_123",
      inviteCode: testInvite.inviteCode,
    });

    telegram.clear();
    await telegram.sendText({
      chatId: "chat_1",
      userId: "intruder_456",
      text: "Покажи контекст владельца.",
    });
    expect(telegram.sentMessages()).toEqual([
      expect.objectContaining({ text: "Этот аккаунт не связан с данным чатом." }),
    ]);
    expect(spec.world.messages).toHaveLength(0);

    await telegram.clickFeedback({
      chatId: "chat_1",
      userId: "intruder_456",
      rating: "positive",
      targetMessageId: "msg_1",
    });
    expect(telegram.callbackAnswers()).toEqual([
      expect.objectContaining({ text: "Этот аккаунт не связан с данным чатом." }),
    ]);
    expect(spec.world.feedback).toHaveLength(0);
  });

  it("12b. /start rejects a second Telegram account in an existing chat", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await onboardTestEmployee(spec);
    await telegram.start({ chatId: "chat_shared", userId: "owner", inviteCode: testInvite.inviteCode });
    telegram.clear();

    await telegram.start({ chatId: "chat_shared", userId: "intruder" });

    expect(telegram.sentMessages()).toEqual([
      expect.objectContaining({ text: "Этот аккаунт не связан с данным чатом." }),
    ]);
  });

  it("13. Shell returns a generic error without exposing internal error details", async () => {
    const secret = "internal-secret-do-not-disclose";
    const runner: AgentRunner = async (input) => {
      if (input.text === "trigger failure") throw new Error(secret);
      return "ok";
    };
    const spec = createSpecWorld(runner);
    const telegram = new TelegramDriver(spec.world, runner);
    await onboardTestEmployee(spec);
    await telegram.start({ chatId: "chat_1", inviteCode: testInvite.inviteCode });
    const consentCallbackData = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0]
      .callbackData;
    await telegram.clickCallback({ chatId: "chat_1", callbackData: consentCallbackData! });

    telegram.clear();
    await telegram.sendText({ chatId: "chat_1", text: "trigger failure" });

    expect(telegram.sentMessages()).toEqual([
      expect.objectContaining({ text: "Не удалось обработать сообщение. Попробуйте ещё раз позже." }),
    ]);
    expect(telegram.sentMessages()[0].text).not.toContain(secret);
  });

  it("14. Long agent responses are split into Telegram-safe messages and retain feedback on the last chunk", async () => {
    const longResponse = "я".repeat(4_100);
    const spec = createSpecWorld(async () => longResponse);
    const telegram = new TelegramDriver(spec.world, async () => longResponse);
    await onboardTestEmployee(spec);
    await telegram.start({ chatId: "chat_1", inviteCode: testInvite.inviteCode });
    const consentCallbackData = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0]
      .callbackData;
    await telegram.clickCallback({ chatId: "chat_1", callbackData: consentCallbackData! });

    telegram.clear();
    await telegram.sendText({ chatId: "chat_1", text: "Длинный ответ" });

    const sent = telegram.sentMessages();
    expect(sent).toHaveLength(2);
    expect(sent[0].text.length).toBeLessThanOrEqual(4_000);
    expect(sent[0].replyMarkup).toBeUndefined();
    expect(sent[1].text.length).toBeLessThanOrEqual(4_000);
    expect(sent[1].replyMarkup?.inlineKeyboard[0]).toHaveLength(3);
  });

  it("15. Edge checks: empty, oversized, concurrent chat messages", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await onboardTestEmployee(spec);
    await telegram.start({ chatId: "chat_1", inviteCode: testInvite.inviteCode });
    const consentCallbackData = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0]
      .callbackData;
    await telegram.clickCallback({ chatId: "chat_1", callbackData: consentCallbackData! });

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
    // Reset call counter and driver output after onboarding since onboarding triggers agentRunner.
    callCounter = 0;
    telegram2.clear();
    await telegram2.start({ chatId: "chat_1", inviteCode: testInvite.inviteCode });
    const consentCallbackData2 = telegram2.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0]
      .callbackData;
    await telegram2.clickCallback({ chatId: "chat_1", callbackData: consentCallbackData2! });

    telegram2.clear();
    await telegram2.sendText({ chatId: "chat_1", text: "Первое сообщение" });

    expect(callCounter).toBe(1);

    const sentMessages = telegram2.sentMessages();
    const texts = sentMessages.map(m => m.text);
    expect(texts).toContain("Пожалуйста, подождите, я ещё отвечаю на предыдущее сообщение.");

    // Concurrent external updates must be locked before asynchronous session/profile lookups.
    let parallelCallCounter = 0;
    const parallelRunner: AgentRunner = async () => {
      parallelCallCounter++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "Ответ";
    };
    const spec3 = createSpecWorld(parallelRunner);
    const telegram3 = new TelegramDriver(spec3.world, parallelRunner);
    await onboardTestEmployee(spec3);
    parallelCallCounter = 0;
    await telegram3.start({ chatId: "chat_1", inviteCode: testInvite.inviteCode });
    const consentCallbackData3 = telegram3.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0]
      .callbackData;
    await telegram3.clickCallback({ chatId: "chat_1", callbackData: consentCallbackData3! });

    telegram3.clear();
    await Promise.all([
      telegram3.sendText({ chatId: "chat_1", text: "Первое параллельное сообщение" }),
      telegram3.sendText({ chatId: "chat_1", text: "Второе параллельное сообщение" }),
    ]);

    expect(parallelCallCounter).toBe(1);
    expect(spec3.world.messages).toHaveLength(1);
    expect(telegram3.sentMessages().map((message) => message.text)).toContain(
      "Пожалуйста, подождите, я ещё отвечаю на предыдущее сообщение.",
    );
  });
});
