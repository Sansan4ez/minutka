import { describe, expect, it } from "vitest";
import { createSpecWorld, registerSpecMetadata, expectEvent } from "../support/spec-harness.js";
import { TelegramDriver } from "../support/telegram-driver.js";
import { testEmployee, testInvite } from "../support/fixtures.js";
import type { AgentRunner } from "../../../src/application/minutka-service.js";
import { onboardTestEmployee } from "../support/onboarding-helper.js";
import { decodeFeedbackCallbackData } from "../../../src/telegram/callback-data.js";
import { parseInviteSeeds } from "../../../src/telegram/invite-seeds.js";
import { createInMemoryRuntime, executableSpecPrivacyExplanation } from "../../../src/runtime/create-in-memory-runtime.js";
import { ConversationThreadService } from "../../../src/application/conversation-thread-service.js";
import { PersonalAssistantService } from "../../../src/application/personal-assistant-service.js";
import { createInMemoryArtifactContentStore } from "../../../src/application/in-memory-artifact-content-store.js";
import { createInMemoryArtifactStore } from "../../../src/application/in-memory-artifact-store.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";
import { createInMemoryTaskStore } from "../../../src/application/in-memory-task-store.js";
import { createDefaultSpecDeps } from "../support/scripted-deps.js";
import { ServiceMinutkaClient } from "../../../src/client/sdk/minutka-client.js";
import { createInProcessServiceTransport } from "../../../src/server/http/in-process-transport.js";
import { createTelegramShell } from "../../../src/telegram/telegram-shell.js";
const privacyExplanation = executableSpecPrivacyExplanation;

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

  it("0. Invite bootstrap parser accepts unique tenant-bound invite entries only", () => {
    expect(parseInviteSeeds("emp_1:invite_a:company_a:group_a,emp_2:invite_b:company_b:group_b")).toEqual([
      { employeeId: "emp_1", inviteCode: "invite_a", companyId: "company_a", groupId: "group_a" },
      { employeeId: "emp_2", inviteCode: "invite_b", companyId: "company_b", groupId: "group_b" },
    ]);
    expect(() => parseInviteSeeds("emp_1:invite_a:company_a:group_a,emp_1:invite_b:company_b:group_b")).toThrow(/duplicate employeeIds/);
    expect(() => parseInviteSeeds("emp_1:invite_a:company_a:group_a,emp_2:invite_a:company_b:group_b")).toThrow(/duplicate inviteCodes/);
    expect(() => parseInviteSeeds("not-an-entry")).toThrow(/employeeId:inviteCode:companyId:groupId/);
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

  it("3a. /new rotates the dialogue thread without changing durable owner data", async () => {
    const observedContexts: string[] = [];
    const historyAwareAgent: AgentRunner = async (_input, context) => {
      observedContexts.push(context?.systemContext ?? "");
      return "Контекст проверен.";
    };
    const spec = createSpecWorld(historyAwareAgent);
    const runtime = createInMemoryRuntime({ world: spec.world, agentRunner: historyAwareAgent, deps: createDefaultSpecDeps() });
    const clock = { now: spec.world.now };
    let nextThread = 0;
    const threadService = new ConversationThreadService(runtime.telegramSessionStore, { clock, idGenerator: { threadId: () => `thread_${++nextThread}` } });
    const artifactStore = createInMemoryArtifactStore({ contentStore: createInMemoryArtifactContentStore(clock), clock, limits: { maximumBytes: 1024, timeoutMs: 1_000 } });
    const ideas = createInMemoryIdeaStore(clock);
    const tasks = createInMemoryTaskStore(clock);
    await ideas.add({ id: "idea_before_reset", userId: testEmployee.employeeId, project: "ASSISTANT", type: "development", summary: "Durable idea", status: "raw" });
    await tasks.create(testEmployee.employeeId, { id: "task_before_reset", title: "Durable task", project: "ASSISTANT", type: "development", status: "open" });
    const resetAwareService = new PersonalAssistantService(runtime.service, {
      async chat(input) {
        const result = await runtime.service.chat({ employeeId: input.userId, threadId: input.threadId, text: input.text, inputModality: input.inputModality, responseChannel: input.responseChannel });
        return { ...result, selectedProcessIds: ["core"], outcome: { status: "completed" as const } };
      },
    }, artifactStore, undefined, threadService);
    const telegram = new TelegramDriver(spec.world, historyAwareAgent, {}, true, undefined, { ...runtime, service: resetAwareService });
    await onboardTestEmployee(spec);
    await telegram.start({ chatId: "new_chat", userId: "new_user", inviteCode: testInvite.inviteCode });
    const consentCallbackData = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.clickCallback({ chatId: "new_chat", userId: "new_user", callbackData: consentCallbackData! });
    await telegram.chooseDefaultRole("new_chat");

    await telegram.sendText({ chatId: "new_chat", userId: "new_user", text: "Старый контекст" });
    const before = {
      profiles: structuredClone(spec.world.profiles),
      participants: structuredClone(spec.world.participants),
      messages: structuredClone(spec.world.messages),
    };
    telegram.clear();

    await telegram.startNewConversation({ chatId: "new_chat", userId: "new_user" });
    expect(telegram.sentMessages()).toEqual([
      expect.objectContaining({ text: "Готово, начали новый диалог. Предыдущий контекст больше не используется." }),
    ]);
    telegram.clear();
    await telegram.sendText({ chatId: "new_chat", userId: "new_user", text: "Новый контекст" });

    expect(observedContexts).toHaveLength(3);
    expect(observedContexts[2]).not.toContain("Старый контекст");
    expect(spec.world.profiles).toEqual(before.profiles);
    expect(spec.world.participants).toEqual(before.participants);
    await expect(ideas.list(testEmployee.employeeId)).resolves.toEqual([expect.objectContaining({ id: "idea_before_reset", summary: "Durable idea" })]);
    await expect(tasks.list(testEmployee.employeeId)).resolves.toEqual([expect.objectContaining({ id: "task_before_reset", title: "Durable task" })]);
    expect(spec.world.messages.filter((message) => message.text === "Старый контекст")).toHaveLength(1);
    expect(spec.world.messages.filter((message) => message.text === "Новый контекст")).toHaveLength(1);
    expect(new Set(spec.world.messages.map((message) => message.threadId)).size).toBe(2);
  });

  it("3b. Shows Telegram typing while a normal chat response is being generated", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await onboardTestEmployee(spec);
    await telegram.start({ chatId: "typing_chat", userId: "typing_user", inviteCode: testInvite.inviteCode });
    const consentCallbackData = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.clickCallback({ chatId: "typing_chat", userId: "typing_user", callbackData: consentCallbackData! });
    await telegram.chooseDefaultRole("typing_chat");
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
    await telegram.chooseDefaultRole("chat_1");
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
    await telegram.chooseDefaultRole("chat_cleanup");
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

  it("6c. Proactive delivery replaces stale feedback buttons and saves feedback for its application message", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await onboardTestEmployee(spec);
    await telegram.start({ chatId: "chat_proactive", userId: "user_proactive", inviteCode: testInvite.inviteCode });
    const consentCallback = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.clickCallback({ chatId: "chat_proactive", userId: "user_proactive", callbackData: consentCallback! });
    await telegram.chooseDefaultRole("chat_proactive");
    telegram.clear();

    await telegram.sendText({ chatId: "chat_proactive", userId: "user_proactive", text: "Первый вопрос" });
    const previous = telegram.sentMessages()[0]!;
    telegram.clear();
    const scheduled = await spec.cli.json<{ messageId: string; response: string }>([
      "employee", "chat", "--employee", testEmployee.employeeId, "--thread", testEmployee.threadId, "--text", "Запланированный фокус",
    ]);
    await telegram.deliverProactive({
      chatId: "chat_proactive",
      employeeId: testEmployee.employeeId,
      result: {
        messageId: scheduled.messageId,
        response: scheduled.response,
        selectedProcessIds: ["core"],
        outcome: { status: "completed" },
        effect: "none",
        pendingActions: [],
      },
    });

    expect(telegram.replyMarkupEditCalls()).toContainEqual({ chatId: "chat_proactive", messageId: previous.messageId, replyMarkup: undefined });
    const proactive = telegram.sentMessages().at(-1)!;
    const feedback = proactive.replyMarkup?.inlineKeyboard[0]?.[0]?.callbackData;
    expect(feedback).toBeTruthy();
    expect(decodeFeedbackCallbackData(feedback!)?.targetMessageId).toBe(scheduled.messageId);

    await telegram.deliverCallback({ chatId: "chat_proactive", userId: "user_proactive", callbackData: feedback!, messageId: proactive.messageId });
    expect(spec.world.feedback).toContainEqual(expect.objectContaining({ targetMessageId: scheduled.messageId, rating: "positive", source: "telegram" }));
  });

  it("6d. Reminder delivery has no feedback buttons, clears stale feedback, and preserves a live confirmation card", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await onboardTestEmployee(spec);
    await telegram.start({ chatId: "chat_reminder", userId: "user_reminder", inviteCode: testInvite.inviteCode });
    const consentCallback = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.clickCallback({ chatId: "chat_reminder", userId: "user_reminder", callbackData: consentCallback! });
    await telegram.chooseDefaultRole("chat_reminder");
    telegram.clear();

    await telegram.sendText({ chatId: "chat_reminder", userId: "user_reminder", text: "Первый вопрос" });
    const previous = telegram.sentMessages()[0]!;
    telegram.clear();
    await telegram.deliverReminder({ chatId: "chat_reminder", employeeId: testEmployee.employeeId, text: "Выпить воды" });

    expect(telegram.replyMarkupEditCalls()).toContainEqual({ chatId: "chat_reminder", messageId: previous.messageId, replyMarkup: undefined });
    expect(telegram.sentMessages()).toEqual([
      expect.objectContaining({ text: "Выпить воды", replyMarkup: undefined }),
    ]);

    telegram.clear();
    const pendingAction = {
      confirmationId: "live-confirmation",
      actionKind: "cancel" as const,
      summary: "Отменить задачу",
      expiresAt: "2026-07-29T09:15:00.000Z",
      preview: {
        kind: "cancel" as const,
        taskId: { value: "task-live", truncated: false },
        taskTitle: { value: "Живая задача", truncated: false },
      },
    };
    await telegram.deliverProactive({
      chatId: "chat_reminder",
      employeeId: testEmployee.employeeId,
      result: {
        messageId: "pending-action-message",
        response: "Предложение подготовлено.",
        selectedProcessIds: ["core"],
        outcome: { status: "completed" },
        effect: "pending_action_created",
        pendingActions: [pendingAction],
      },
    });
    const confirmation = telegram.sentMessages().at(-1)!;
    telegram.clear();

    await telegram.deliverReminder({ chatId: "chat_reminder", employeeId: testEmployee.employeeId, text: "Позвонить маме" });

    expect(telegram.replyMarkupEditCalls()).not.toContainEqual({ chatId: "chat_reminder", messageId: confirmation.messageId, replyMarkup: undefined });
    expect(telegram.sentMessages()).toEqual([
      expect.objectContaining({ text: "Позвонить маме", replyMarkup: undefined }),
    ]);
    expect(spec.world.feedback).toEqual([]);
  });

  it("7 & 8. Repeated /start for already linked chat / different invite behavior", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await onboardTestEmployee(spec);

    // Initial start
    await telegram.start({ chatId: "chat_1", inviteCode: testInvite.inviteCode });
    const consentCallbackData = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.clickCallback({ chatId: "chat_1", callbackData: consentCallbackData! });
    await telegram.chooseDefaultRole("chat_1");

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
    await telegram.chooseDefaultRole("chat_1");

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

  it("10a. Shows role names in buttons and confirmation while callbacks keep role ids", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    spec.world.tenantDirectories.groups.push({ id: "pilot_group", companyId: "pilot_company" });
    spec.world.tenantDirectories.roles.push({ id: "role_acme_logistics", companyId: "pilot_company", name: "Логист" });
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await spec.cli.json([
      "employee", "issue-invite",
      "--invite", "invite_named_role",
      "--employee", "emp_named_role",
      "--company", "pilot_company",
      "--group", "pilot_group",
    ]);
    await telegram.start({ chatId: "chat_named_role", inviteCode: "invite_named_role" });
    const consent = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.clickCallback({ chatId: "chat_named_role", callbackData: consent! });
    await telegram.clickCallback({ chatId: "chat_named_role", callbackData: "ob:roleId:role_acme_logistics" });
    telegram.clear();

    await telegram.sendText({ chatId: "chat_named_role", text: "неизвестная должность" });
    const rolePrompt = telegram.sentMessages()[0];
    expect(rolePrompt.text).toContain("Не нашёл такую должность");
    expect(rolePrompt.replyMarkup?.inlineKeyboard).toEqual([[{ text: "Логист", callbackData: "ob:roleId:role_acme_logistics" }]]);

    await telegram.clickCallback({ chatId: "chat_named_role", callbackData: "ob:roleId:role_acme_logistics", messageId: rolePrompt.messageId });
    telegram.clear();
    await telegram.sendText({ chatId: "chat_named_role", text: "Максим | Спарк | На ты | Деловой | Коротко | Europe/Moscow" });
    expect(telegram.sentMessages()[0].text).toContain("- должность: Логист;");
    expect(telegram.sentMessages()[0].text).not.toContain("role_acme_logistics");
    expect(spec.world.onboardingDrafts[0]).toMatchObject({ roleId: "role_acme_logistics", status: "awaiting_confirmation" });
  });

  it("10b. Keeps repeated confirmation input responsive and concurrent confirm callbacks idempotent", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await spec.cli.run(["employee", "issue-invite", "--invite", "invite_confirmation_dedupe", "--employee", "emp_confirmation_dedupe"]);
    await telegram.start({ chatId: "chat_confirmation_dedupe", inviteCode: "invite_confirmation_dedupe" });
    const consent = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.clickCallback({ chatId: "chat_confirmation_dedupe", callbackData: consent! });
    await telegram.chooseDefaultRole("chat_confirmation_dedupe");
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
    await telegram.chooseDefaultRole("chat_confirmation_retry");
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
    await telegram.chooseDefaultRole("chat_stale_confirmation");
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

  it("10ac. Recovers an abandoned consent action claim after the Telegram shell restarts", async () => {
    const world = createSpecWorld(dummyAgentRunner).world;
    const runtime = createInMemoryRuntime({ world, agentRunner: dummyAgentRunner });
    await runtime.service.issueInvite({ employeeId: "emp_consent_crash", inviteCode: "invite_consent_crash", companyId: "default_company", groupId: "default_group" });
    const firstShell = new TelegramDriver(world, dummyAgentRunner, {}, true, undefined, runtime);
    await firstShell.start({ chatId: "chat_consent_crash", inviteCode: "invite_consent_crash" });
    const prompt = firstShell.sentMessages()[0];
    const consent = prompt.replyMarkup?.inlineKeyboard[0][0].callbackData;
    await runtime.telegramSessionStore.claimActionMessage({
      identity: { chatId: "chat_consent_crash", userId: "user_chat_consent_crash" },
      employeeId: "emp_consent_crash",
      messageId: prompt.messageId,
      claimedAt: new Date(Date.now() - 61_000).toISOString(),
      staleBefore: new Date(Date.now() - 121_000).toISOString(),
    });

    const restartedShell = new TelegramDriver(world, dummyAgentRunner, {}, true, undefined, runtime);
    await restartedShell.deliverCallback({ chatId: "chat_consent_crash", callbackData: consent!, messageId: prompt.messageId, callbackQueryId: "consent_recovered" });

    expect(restartedShell.callbackAnswers()).toContainEqual({ callbackQueryId: "consent_recovered", text: "Согласие принято!" });
    expect(restartedShell.sentMessages()).toContainEqual(expect.objectContaining({ text: expect.stringContaining("Давайте коротко познакомимся") }));
    expect(world.auditEvents.filter((event) => event.type === "consent_accepted")).toHaveLength(1);
  });

  it("10aca. Keeps completed consent keyboards idempotent after the Telegram shell restarts", async () => {
    const world = createSpecWorld(dummyAgentRunner).world;
    const runtime = createInMemoryRuntime({ world, agentRunner: dummyAgentRunner });
    await runtime.service.issueInvite({ employeeId: "emp_consent_restart", inviteCode: "invite_consent_restart", companyId: "default_company", groupId: "default_group" });
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
    await runtime.service.issueInvite({ employeeId: "emp_confirm_retry", inviteCode: "invite_confirm_retry", companyId: "default_company", groupId: "default_group" });
    const telegram = new TelegramDriver(world, dummyAgentRunner, {}, true, undefined, runtime);
    await telegram.start({ chatId: "chat_confirm_retry", inviteCode: "invite_confirm_retry" });
    const consent = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.clickCallback({ chatId: "chat_confirm_retry", callbackData: consent! });
    await telegram.chooseDefaultRole("chat_confirm_retry");
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

  it("10ada. Shares callback work before the durable action claim resolves", async () => {
    const world = createSpecWorld(dummyAgentRunner).world;
    let attempts = 0;
    const runtime = createInMemoryRuntime({
      world,
      agentRunner: dummyAgentRunner,
      deps: {
        onboardingContextMaterializer: {
          async materialize() {
            attempts += 1;
            if (attempts === 1) throw new Error("temporary context failure");
            return [];
          },
        },
      },
    });
    await runtime.service.issueInvite({ employeeId: "emp_confirm_claim_race", inviteCode: "invite_confirm_claim_race", companyId: "default_company", groupId: "default_group" });
    const telegram = new TelegramDriver(world, dummyAgentRunner, {}, true, undefined, runtime);
    await telegram.start({ chatId: "chat_confirm_claim_race", inviteCode: "invite_confirm_claim_race" });
    const consent = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.clickCallback({ chatId: "chat_confirm_claim_race", callbackData: consent! });
    await telegram.chooseDefaultRole("chat_confirm_claim_race");
    telegram.clear();
    await telegram.sendText({ chatId: "chat_confirm_claim_race", text: "Максим | Спарк | На ты | Деловой | Коротко | Europe/Moscow" });
    const confirmation = telegram.sentMessages()[0];
    const confirm = confirmation.replyMarkup?.inlineKeyboard[0][0].callbackData;
    telegram.clear();

    const originalClaim = runtime.telegramSessionStore.claimActionMessage.bind(runtime.telegramSessionStore);
    let claimCalls = 0;
    let firstClaimCompleted!: () => void;
    let releaseFirstClaim!: () => void;
    const firstClaimCompletion = new Promise<void>((resolve) => { firstClaimCompleted = resolve; });
    const firstClaimRelease = new Promise<void>((resolve) => { releaseFirstClaim = resolve; });
    runtime.telegramSessionStore.claimActionMessage = async (input) => {
      claimCalls += 1;
      const result = await originalClaim(input);
      if (claimCalls === 1) {
        firstClaimCompleted();
        await firstClaimRelease;
      }
      return result;
    };

    const first = telegram.deliverCallback({ chatId: "chat_confirm_claim_race", callbackData: confirm!, messageId: confirmation.messageId, callbackQueryId: "confirm_claim_failing" });
    await firstClaimCompletion;
    const second = telegram.deliverCallback({ chatId: "chat_confirm_claim_race", callbackData: confirm!, messageId: confirmation.messageId, callbackQueryId: "confirm_claim_retry" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(claimCalls).toBe(1);
    expect(telegram.callbackAnswers()).not.toContainEqual({ callbackQueryId: "confirm_claim_retry", text: "Профиль уже сохранён." });
    expect(telegram.replyMarkupEditCalls()).toHaveLength(0);

    releaseFirstClaim();
    await Promise.all([first, second]);

    expect(attempts).toBe(2);
    expect(world.profiles).toHaveLength(1);
    expect(telegram.callbackAnswers()).toContainEqual({ callbackQueryId: "confirm_claim_failing", text: "Не удалось сохранить профиль. Попробуйте ещё раз позже." });
    expect(telegram.callbackAnswers()).toContainEqual({ callbackQueryId: "confirm_claim_retry", text: "Профиль сохранён!" });
    expect(telegram.callbackAnswers()).not.toContainEqual({ callbackQueryId: "confirm_claim_retry", text: "Профиль уже сохранён." });
    expect(telegram.replyMarkupEditCalls()).toContainEqual({ chatId: "chat_confirm_claim_race", messageId: confirmation.messageId, replyMarkup: undefined });
  });

  it("10a. Lets the employee correct a summary through the edit callback and textual confirmation", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner);
    await spec.cli.run(["employee", "issue-invite", "--invite", "invite_correction", "--employee", "emp_correction"]);
    await telegram.start({ chatId: "chat_correction", inviteCode: "invite_correction" });
    const consent = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.clickCallback({ chatId: "chat_correction", callbackData: consent! });
    await telegram.chooseDefaultRole("chat_correction");
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
    await telegram.chooseDefaultRole("chat_ai_button");
    telegram.clear();
    await telegram.sendText({ chatId: "chat_ai_button", text: "Меня зовут Максим. Тебя зовут Спарк. Общаемся на ты, стиль деловой." });
    const short = telegram.sentMessages().at(-1)?.replyMarkup?.inlineKeyboard[0][0];
    expect(short).toMatchObject({ text: "Коротко", callbackData: "ob:responseLength:short" });
    await telegram.clickCallback({ chatId: "chat_ai_button", callbackData: short!.callbackData });
    const timezonePrompt = telegram.sentMessages().at(-1);
    expect(timezonePrompt?.text).toContain("часовой пояс");
    expect(timezonePrompt?.replyMarkup?.inlineKeyboard.flat()).toContainEqual({ text: "Екатеринбург", callbackData: "ob:timezone:Asia/Yekaterinburg" });
  });

  it("10bc. Saves a timezone button, removes its keyboard, and shows local time in confirmation", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner, { onboardingProfileExtractor: async () => { throw new Error("unavailable"); } });
    await spec.cli.run(["employee", "issue-invite", "--invite", "invite_timezone_button", "--employee", "emp_timezone_button"]);
    await telegram.start({ chatId: "chat_timezone_button", inviteCode: "invite_timezone_button" });
    const consent = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.clickCallback({ chatId: "chat_timezone_button", callbackData: consent! });
    await telegram.chooseDefaultRole("chat_timezone_button");
    telegram.clear();

    await telegram.sendText({ chatId: "chat_timezone_button", text: "Максим | Спарк | На ты | Деловой | Коротко | ?" });
    const timezonePrompt = telegram.sentMessages().at(-1)!;
    const yekaterinburg = timezonePrompt.replyMarkup?.inlineKeyboard.flat().find((button) => button.text === "Екатеринбург");
    expect(yekaterinburg).toMatchObject({ callbackData: "ob:timezone:Asia/Yekaterinburg" });

    await telegram.deliverCallback({ chatId: "chat_timezone_button", callbackData: yekaterinburg!.callbackData, messageId: timezonePrompt.messageId, callbackQueryId: "timezone_choice" });

    expect(spec.world.onboardingDrafts[0]).toMatchObject({ timezone: "Asia/Yekaterinburg", status: "awaiting_confirmation" });
    expect(telegram.replyMarkupEditCalls()).toContainEqual({ chatId: "chat_timezone_button", messageId: timezonePrompt.messageId, replyMarkup: undefined });
    expect(telegram.sentMessages().at(-1)?.text).toMatch(/часовой пояс: Asia\/Yekaterinburg \(сейчас у вас \d{2}:\d{2}\)/u);
  });

  it("10bd. Explains an unrecognized free-text timezone and restores the picker", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner, { onboardingProfileExtractor: async () => { throw new Error("unavailable"); } });
    await spec.cli.run(["employee", "issue-invite", "--invite", "invite_timezone_retry", "--employee", "emp_timezone_retry"]);
    await telegram.start({ chatId: "chat_timezone_retry", inviteCode: "invite_timezone_retry" });
    const consent = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.clickCallback({ chatId: "chat_timezone_retry", callbackData: consent! });
    await telegram.chooseDefaultRole("chat_timezone_retry");
    telegram.clear();
    await telegram.sendText({ chatId: "chat_timezone_retry", text: "Максим | Спарк | На ты | Деловой | Коротко | ?" });
    telegram.clear();

    await telegram.sendText({ chatId: "chat_timezone_retry", text: "не знаю какой" });

    const retry = telegram.sentMessages().at(-1);
    expect(retry?.text).toContain("Не узнал этот пояс");
    expect(retry?.replyMarkup?.inlineKeyboard.flat()).toContainEqual({ text: "Москва", callbackData: "ob:timezone:Europe/Moscow" });
  });

  it("10ba. Serializes onboarding callbacks with concurrent text deliveries", async () => {
    const spec = createSpecWorld(dummyAgentRunner);
    const telegram = new TelegramDriver(spec.world, dummyAgentRunner, { onboardingProfileExtractor: async () => { throw new Error("unavailable"); } });
    await spec.cli.run(["employee", "issue-invite", "--invite", "invite_callback_text_race", "--employee", "emp_callback_text_race"]);
    await telegram.start({ chatId: "chat_callback_text_race", inviteCode: "invite_callback_text_race" });
    const consent = telegram.sentMessages()[0].replyMarkup?.inlineKeyboard[0][0].callbackData;
    await telegram.clickCallback({ chatId: "chat_callback_text_race", callbackData: consent! });
    await telegram.chooseDefaultRole("chat_callback_text_race");
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

  it("10bb. Keeps the chat busy until both callbacks from a double-click finish", async () => {
    const world = createSpecWorld(dummyAgentRunner).world;
    const runtime = createInMemoryRuntime({ world, agentRunner: dummyAgentRunner });
    await runtime.service.issueInvite({ employeeId: "emp_callback_double", inviteCode: "invite_callback_double", companyId: "default_company", groupId: "default_group" });
    const sent: Array<{ messageId: number; text: string; replyMarkup?: { inlineKeyboard: Array<Array<{ callbackData: string }>> } }> = [];
    const callbacks: Array<{ callbackQueryId: string; text?: string }> = [];
    let firstAnswerStarted!: () => void;
    let releaseFirstAnswer!: () => void;
    let secondAnswerStarted!: () => void;
    let releaseSecondAnswer!: () => void;
    const firstAnswer = new Promise<void>((resolve) => { firstAnswerStarted = resolve; });
    const firstAnswerRelease = new Promise<void>((resolve) => { releaseFirstAnswer = resolve; });
    const secondAnswer = new Promise<void>((resolve) => { secondAnswerStarted = resolve; });
    const secondAnswerRelease = new Promise<void>((resolve) => { releaseSecondAnswer = resolve; });
    const shell = createTelegramShell({
      privacyExplanation: executableSpecPrivacyExplanation, client: new ServiceMinutkaClient(createInProcessServiceTransport(runtime.service, { kind: "service", serviceId: "telegram-spec" })),
      sessionStore: runtime.telegramSessionStore,
      replyPort: {
        async sendMessage(_chatId, text, options) {
          const messageId = sent.length + 1;
          sent.push({ messageId, text, ...(options?.replyMarkup === undefined ? {} : { replyMarkup: options.replyMarkup }) });
          return { messageId };
        },
        async editReplyMarkup() {},
        async sendChatAction() {},
        async answerCallbackQuery(callbackQueryId, text) {
          if (callbackQueryId === "consent_first") { firstAnswerStarted(); await firstAnswerRelease; }
          if (callbackQueryId === "consent_second") { secondAnswerStarted(); await secondAnswerRelease; }
          callbacks.push({ callbackQueryId, text });
        },
      },
    });
    await shell.handleStart("chat_callback_double", "invite_callback_double", "user_callback_double");
    const prompt = sent[0];
    const consent = prompt.replyMarkup?.inlineKeyboard[0][0].callbackData;
    sent.length = 0;

    const first = shell.handleCallback("chat_callback_double", "consent_first", consent!, "user_callback_double", prompt.messageId);
    await firstAnswer;
    const second = shell.handleCallback("chat_callback_double", "consent_second", consent!, "user_callback_double", prompt.messageId);
    await secondAnswer;
    releaseFirstAnswer();
    await first;
    await shell.handleText("chat_callback_double", "Сообщение между завершениями callback", "user_callback_double");

    expect(sent).toContainEqual(expect.objectContaining({ text: "Пожалуйста, подождите, я ещё отвечаю на предыдущее сообщение." }));
    releaseSecondAnswer();
    await second;
    expect(callbacks).toContainEqual({ callbackQueryId: "consent_first", text: "Согласие принято!" });
    expect(callbacks).toContainEqual({ callbackQueryId: "consent_second", text: "Уже обработано." });
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

  it("10d. Reopens consent when a linked owner has only an obsolete privacy acceptance", async () => {
    const world = createSpecWorld(dummyAgentRunner).world;
    const runtime = createInMemoryRuntime({ world, agentRunner: dummyAgentRunner });
    const identity = { chatId: "chat_reconsent", userId: "user_reconsent" };
    const acceptedAt = world.now();
    await runtime.service.issueInvite({ employeeId: "emp_reconsent", inviteCode: "invite_reconsent", companyId: "default_company", groupId: "default_group" });
    await runtime.service.openInvite({ inviteCode: "invite_reconsent" });
    world.consents.push({ employeeId: "emp_reconsent", privacyVersion: "privacy-v1", acceptedAt, explanationShownAt: acceptedAt, source: "test" });
    await runtime.telegramSessionStore.claim({
      identity,
      session: { employeeId: "emp_reconsent", threadId: "emp_reconsent", createdAt: acceptedAt, updatedAt: acceptedAt },
    });
    await runtime.telegramSessionStore.markConsentAccepted({ identity, employeeId: "emp_reconsent", acceptedAt, privacyVersion: "privacy-v1" });
    expect(await runtime.telegramSessionStore.getByIdentity(identity)).toEqual(expect.objectContaining({
      consentAcceptedAt: acceptedAt,
      consentPrivacyVersion: "privacy-v1",
    }));
    const sent: string[] = [];
    const shell = createTelegramShell({
      privacyExplanation: executableSpecPrivacyExplanation, client: new ServiceMinutkaClient(createInProcessServiceTransport(runtime.service, { kind: "service", serviceId: "telegram-spec" })),
      sessionStore: runtime.telegramSessionStore,
      replyPort: {
        async sendMessage(_chatId, text) { sent.push(text); return { messageId: sent.length }; },
        async editReplyMarkup() {}, async sendChatAction() {}, async answerCallbackQuery() {},
      },
    });

    await shell.handleStart(identity.chatId, undefined, identity.userId);
    expect(sent).toEqual([privacyExplanation]);
  });

  it("10e. Reopens consent when a linked owner has not accepted privacy", async () => {
    const world = createSpecWorld(dummyAgentRunner).world;
    const runtime = createInMemoryRuntime({ world, agentRunner: dummyAgentRunner });
    const identity = { chatId: "chat_missing_consent", userId: "user_missing_consent" };
    await runtime.service.issueInvite({ employeeId: "emp_missing_consent", inviteCode: "invite_missing_consent", companyId: "default_company", groupId: "default_group" });
    await runtime.service.openInvite({ inviteCode: "invite_missing_consent" });
    await runtime.telegramSessionStore.claim({
      identity,
      session: { employeeId: "emp_missing_consent", threadId: "emp_missing_consent", createdAt: world.now(), updatedAt: world.now() },
    });
    expect(await runtime.telegramSessionStore.getByIdentity(identity)).not.toHaveProperty("consentAcceptedAt");
    const sent: string[] = [];
    const shell = createTelegramShell({
      privacyExplanation: executableSpecPrivacyExplanation, client: new ServiceMinutkaClient(createInProcessServiceTransport(runtime.service, { kind: "service", serviceId: "telegram-spec" })),
      sessionStore: runtime.telegramSessionStore,
      replyPort: {
        async sendMessage(_chatId, text) { sent.push(text); return { messageId: sent.length }; },
        async editReplyMarkup() {}, async sendChatAction() {}, async answerCallbackQuery() {},
      },
    });

    await shell.handleStart(identity.chatId, undefined, identity.userId);
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
    await telegram.chooseDefaultRole("chat_1");

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
    await telegram.chooseDefaultRole("chat_1");

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
    await telegram.chooseDefaultRole("chat_1");

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
