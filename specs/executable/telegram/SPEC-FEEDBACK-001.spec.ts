import { describe, expect, it } from "vitest";
import { createSpecWorld, registerSpecMetadata, expectEvent } from "../support/spec-harness.js";
import { TelegramDriver } from "../support/telegram-driver.js";
import { testEmployee, testInvite } from "../support/fixtures.js";
import type { AgentRunner } from "../../../src/application/minutka-service.js";
import { onboardTestEmployee } from "../support/onboarding-helper.js";
import { decodeFeedbackCallbackData } from "../../../src/telegram/callback-data.js";
import { parseInviteSeeds } from "../../../src/telegram/invite-seeds.js";

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

  it("6. Repeated feedback callback on the same targetMessageId does not create duplicate (upserts rating)", async () => {
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
    expect(telegram.sentMessages()[0].text).toContain("Чтобы завершить настройку");
    expect(spec.world.messages).toHaveLength(0);

    telegram.clear();
    await telegram.sendText({
      chatId: "chat_1",
      text: "Руководитель проектов | планирование; встречи | efficiency | intermediate",
    });
    expect(telegram.sentMessages()[0].text).toBe("Я робот-помощник Минутка.");
    expect(spec.world.profiles).toHaveLength(1);

    telegram.clear();
    await telegram.sendText({ chatId: "chat_1", text: "Сегодня много созвонов." });
    expect(telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0]).toHaveLength(3);
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
        text: [
          "Минутка хранит ваш личный рабочий контекст, чтобы помогать вам разбирать день.",
          "Компания не получает личные диалоги, ФИО, индивидуальные задачи или ваше состояние.",
          "Для компании используются только обезличенные агрегированные сигналы по группам от 5 сотрудников.",
        ].join("\n"),
        replyMarkup: expect.objectContaining({
          inlineKeyboard: [[expect.objectContaining({ callbackData: "tg:consent:emp_retry" })]],
        }),
      }),
    ]);
    expect(
      spec.world.events.filter((event) => event.type === "PrivacyExplanationShown"),
    ).toHaveLength(1);
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
