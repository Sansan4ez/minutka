import { describe, expect, it } from "vitest";
import { AssistantService } from "../../../src/application/assistant-service.js";
import { createInMemoryArtifactContentStore } from "../../../src/application/in-memory-artifact-content-store.js";
import { createInMemoryArtifactStore } from "../../../src/application/in-memory-artifact-store.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";
import { createInMemoryTaskMutationConfirmationStore } from "../../../src/application/in-memory-task-mutation-confirmation-store.js";
import { createInMemoryTaskStore } from "../../../src/application/in-memory-task-store.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { PersonalAssistantService } from "../../../src/application/personal-assistant-service.js";
import { createDeterministicIdGenerator } from "../../../src/application/runtime-primitives.js";
import { TaskMutationConfirmationService } from "../../../src/application/task-mutation-confirmation.js";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import { taskDecisionText } from "../../../src/telegram/telegram-shell.js";
import { TelegramDriver } from "../support/telegram-driver.js";
import { createDefaultSpecDeps } from "../support/scripted-deps.js";

const owner = { employeeId: "task-owner", inviteCode: "task-invite", chatId: "task-chat", userId: "task-user" };

async function harness(runner: ConstructorParameters<typeof AssistantService>[0]) {
  let now = "2026-07-29T09:00:00.000Z";
  const clock = { now: () => now };
  const legacy = createInMemoryRuntime({ agentRunner: async () => "legacy", deps: createDefaultSpecDeps() });
  await legacy.service.issueInvite({ employeeId: owner.employeeId, inviteCode: owner.inviteCode });
  await legacy.service.redeemTelegramInvite({ inviteCode: owner.inviteCode, identity: { chatId: owner.chatId, userId: owner.userId } });
  await legacy.service.acceptConsent({ employeeId: owner.employeeId, accepted: true, source: "test", telegramIdentity: { chatId: owner.chatId, userId: owner.userId } });
  await legacy.service.completeOnboarding({ employeeId: owner.employeeId, role: "Owner", typicalTasks: ["planning"], persona: "efficiency", aiLevel: "advanced" });
  const documents = createInMemoryDocumentStore(clock);
  const ideas = createInMemoryIdeaStore(clock);
  const tasks = createInMemoryTaskStore(clock);
  const taskMutations = new TaskMutationConfirmationService(
    createInMemoryTaskMutationConfirmationStore(tasks), clock,
    { confirmationId: (() => { let id = 0; return () => `telegram-confirmation-${++id}`; })() },
  );
  const assistant = new AssistantService(runner, {
    documentStore: documents,
    conversationStore: createInMemoryConversationStore(legacy.world),
    ingestionService: createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock), ideaStore: ideas }),
    ideaStore: ideas, taskStore: tasks, taskMutations,
    requestIntegrityGuard: async () => ({ status: "allowed" }), clock, idGenerator: createDeterministicIdGenerator(),
  });
  const artifacts = createInMemoryArtifactStore({ contentStore: createInMemoryArtifactContentStore(clock), clock, limits: { maximumBytes: 1024, timeoutMs: 1_000 } });
  const facade = new PersonalAssistantService(legacy.service, assistant, artifacts, taskMutations);
  const telegram = new TelegramDriver(legacy.world, async () => "legacy", {}, true, undefined, { ...legacy, service: facade }, { saveArtifact: (input) => facade.saveArtifact(input) });
  return { telegram, tasks, setNow(value: string) { now = value; } };
}

function taskButton(message: ReturnType<TelegramDriver["sentMessages"]>[number], text: string): string {
  const button = message.replyMarkup?.inlineKeyboard.flat().find((candidate) => candidate.text === text);
  if (!button) throw new Error(`button ${text} not found`);
  return button.callbackData;
}

describe("SPEC-PERSONAL-ASSISTANT-TELEGRAM-TASK-CONFIRMATION-001: typed Telegram task decisions", () => {
  it.each([
    ["text" as const],
    ["voice" as const],
  ])("renders one typed Confirm/Reject proposal for %s input and confirms it once", async (modality) => {
    const { telegram, tasks } = await harness(async (_input, context) => {
      await context.tasks.propose({ kind: "create", title: `Task from ${modality}`, project: "ASSISTANT", type: "operations" });
      return "Предложение подготовлено.";
    });
    if (modality === "text") await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "create" });
    else await telegram.sendVoice({ chatId: owner.chatId, userId: owner.userId, fileId: "voice-task", transcript: "create", durationSeconds: 1 });

    const proposals = telegram.sentMessages().filter((message) => message.text.includes("Предложение:"));
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.text).toContain(`Действие: создать задачу\nНазвание: Task from ${modality}\nПроект: ASSISTANT\nТип: operations\nСрок: не указан`);
    expect(proposals[0]!.replyMarkup?.inlineKeyboard.flat().map(({ text }) => text)).toEqual(["✅ Подтвердить", "❌ Отклонить"]);
    expect(taskButton(proposals[0]!, "✅ Подтвердить")).toBe("tm:c:telegram-confirmation-1");
    expect(telegram.sentMessages().findIndex((message) => message === proposals[0])).toBeLessThan(telegram.sentMessages().findIndex((message) => message.text === "Предложение подготовлено."));
    await expect(tasks.list(owner.employeeId)).resolves.toEqual([]);

    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: taskButton(proposals[0]!, "✅ Подтвердить"), messageId: proposals[0]!.messageId, callbackQueryId: "confirm-1" });
    expect(telegram.callbackAnswers().at(-1)?.text).toBe("Изменение сохранено.");
    await expect(tasks.list(owner.employeeId)).resolves.toMatchObject([{ title: `Task from ${modality}` }]);
    expect(telegram.replyMarkupEditCalls()).toContainEqual({ chatId: owner.chatId, messageId: proposals[0]!.messageId, replyMarkup: undefined });

    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: taskButton(proposals[0]!, "✅ Подтвердить"), messageId: proposals[0]!.messageId, callbackQueryId: "confirm-2" });
    expect(telegram.callbackAnswers().at(-1)?.text).toBe("Уже обработано.");
    await expect(tasks.list(owner.employeeId)).resolves.toHaveLength(1);
  });

  it.each([
    ["text" as const],
    ["voice" as const],
  ])("retries delivery of the same %s proposal before exposing the assistant response", async (modality) => {
    let turns = 0;
    const { telegram, tasks } = await harness(async (_input, context) => {
      turns += 1;
      await context.tasks.propose({ kind: "create", title: `Retry ${modality}`, project: "ASSISTANT", type: "operations" });
      return "Предложение подготовлено.";
    });
    if (modality === "voice") telegram.setMessageDeliverySequence("pass", "fail");
    else telegram.failNextMessageDelivery();

    if (modality === "text") await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "create" });
    else await telegram.sendVoice({ chatId: owner.chatId, userId: owner.userId, fileId: "retry-voice-task", transcript: "create", durationSeconds: 1 });

    const attempts = telegram.messageDeliveryAttempts().filter((message) => message.text.includes("Предложение:"));
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
    const proposal = telegram.sentMessages().find((message) => message.text.includes("Предложение:"))!;
    expect(telegram.sentMessages().findIndex((message) => message === proposal)).toBeLessThan(telegram.sentMessages().findIndex((message) => message.text === "Предложение подготовлено."));
    expect(telegram.taskMutationRejectCalls()).toEqual([]);
    expect(turns).toBe(1);

    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: taskButton(proposal, "✅ Подтвердить"), messageId: proposal.messageId, callbackQueryId: `retry-${modality}` });
    await expect(tasks.list(owner.employeeId)).resolves.toMatchObject([{ title: `Retry ${modality}` }]);
  });

  it("keeps duplicate proposal buttons safe when the first delivery outcome is uncertain", async () => {
    const { telegram, tasks } = await harness(async (_input, context) => {
      await context.tasks.propose({ kind: "create", title: "Duplicate buttons", project: "ASSISTANT", type: "operations" });
      return "Предложение подготовлено.";
    });
    telegram.setMessageDeliverySequence("deliver_then_fail");

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "create" });

    const proposals = telegram.sentMessages().filter((message) => message.text.includes("Предложение:"));
    expect(proposals).toHaveLength(2);
    expect(taskButton(proposals[0]!, "✅ Подтвердить")).toBe(taskButton(proposals[1]!, "✅ Подтвердить"));

    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: taskButton(proposals[0]!, "✅ Подтвердить"), messageId: proposals[0]!.messageId, callbackQueryId: "confirm-first-duplicate" });
    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: taskButton(proposals[1]!, "✅ Подтвердить"), messageId: proposals[1]!.messageId, callbackQueryId: "confirm-second-duplicate" });

    expect(telegram.callbackAnswers().at(-1)?.text).toBe("Изменение уже сохранено.");
    await expect(tasks.list(owner.employeeId)).resolves.toMatchObject([{ title: "Duplicate buttons" }]);
    await expect(tasks.list(owner.employeeId)).resolves.toHaveLength(1);
  });

  it("keeps delivered proposal buttons valid when the following assistant text delivery fails", async () => {
    let turns = 0;
    const { telegram, tasks } = await harness(async (_input, context) => {
      turns += 1;
      await context.tasks.propose({ kind: "create", title: "Visible before text failure", project: "ASSISTANT", type: "operations" });
      return "Предложение подготовлено.";
    });
    telegram.setMessageDeliverySequence("pass", "fail");

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "create" });

    const proposal = telegram.sentMessages().find((message) => message.text.includes("Предложение:"))!;
    expect(telegram.sentMessages().at(-1)?.text).toBe("Не удалось обработать сообщение. Попробуйте ещё раз позже.");
    expect(telegram.replyMarkupEditCalls()).not.toContainEqual({ chatId: owner.chatId, messageId: proposal.messageId, replyMarkup: undefined });
    expect(telegram.taskMutationRejectCalls()).toEqual([]);
    expect(turns).toBe(1);

    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: taskButton(proposal, "✅ Подтвердить"), messageId: proposal.messageId, callbackQueryId: "confirm-after-text-failure" });
    await expect(tasks.list(owner.employeeId)).resolves.toMatchObject([{ title: "Visible before text failure" }]);
  });

  it.each([
    ["text" as const],
    ["voice" as const],
  ])("terminally rejects a %s proposal after two delivery failures and reports cancellation honestly", async (modality) => {
    let turns = 0;
    const { telegram, tasks } = await harness(async (_input, context) => {
      turns += 1;
      await context.tasks.propose({ kind: "create", title: `Undeliverable ${modality}`, project: "ASSISTANT", type: "operations" });
      return "Предложение подготовлено.";
    });
    if (modality === "voice") telegram.setMessageDeliverySequence("pass", "fail", "fail");
    else telegram.setMessageDeliverySequence("fail", "fail");

    if (modality === "text") await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "create" });
    else await telegram.sendVoice({ chatId: owner.chatId, userId: owner.userId, fileId: "undeliverable-voice-task", transcript: "create", durationSeconds: 1 });

    expect(telegram.messageDeliveryAttempts().filter((message) => message.text.includes("Предложение:"))).toHaveLength(2);
    expect(telegram.taskMutationRejectCalls()).toEqual(["telegram-confirmation-1"]);
    expect(telegram.sentMessages().map((message) => message.text)).toContain("Не удалось доставить предложение. Оно отменено; создайте новое предложение позже.");
    expect(telegram.sentMessages().map((message) => message.text)).not.toContain("Предложение подготовлено.");
    expect(turns).toBe(1);
    await expect(tasks.list(owner.employeeId)).resolves.toEqual([]);

    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: "tm:c:telegram-confirmation-1", callbackQueryId: `confirm-cancelled-${modality}-delivery` });
    expect(telegram.callbackAnswers().at(-1)?.text).toBe("Предложение уже отклонено.");
    await expect(tasks.list(owner.employeeId)).resolves.toEqual([]);
  });

  it("does not claim cancellation or repeat the agent when terminal rejection is uncertain", async () => {
    let turns = 0;
    const { telegram, tasks } = await harness(async (_input, context) => {
      turns += 1;
      await context.tasks.propose({ kind: "create", title: "Uncertain rejection", project: "ASSISTANT", type: "operations" });
      return "Предложение подготовлено.";
    });
    telegram.setMessageDeliverySequence("fail", "fail");
    telegram.failNextTaskMutationRejection();

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "create" });

    expect(telegram.taskMutationRejectCalls()).toEqual(["telegram-confirmation-1"]);
    expect(telegram.sentMessages().at(-1)?.text).toBe("Не удалось доставить предложение и проверить его отмену. Статус предложения неизвестен; попробуйте позже.");
    expect(telegram.sentMessages().at(-1)?.text).not.toContain("отменено");
    expect(turns).toBe(1);

    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: "tm:c:telegram-confirmation-1", callbackQueryId: "confirm-after-uncertain-reject" });
    expect(telegram.callbackAnswers().at(-1)?.text).toBe("Изменение сохранено.");
    await expect(tasks.list(owner.employeeId)).resolves.toMatchObject([{ title: "Uncertain rejection" }]);
  });

  it("renders unsafe task text as inert tokens without allowing labels or field boundaries to be reordered", async () => {
    const unsafeTaskId = "task\u2066id\u2069";
    const unsafeTitle = "left\u202Eright\u200D\u0001\nnext";
    const unsafeProject = "pro\u2067ject\u2069\u0085";
    const { telegram } = await harness(async (_input, context) => {
      await context.tasks.propose({
        kind: "update",
        taskId: unsafeTaskId,
        expectedRevision: 3,
        patch: { title: unsafeTitle, project: unsafeProject, type: "development", status: "in_progress", dueDate: null },
      });
      return "Предложение подготовлено.";
    });

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "unsafe update" });

    const proposal = telegram.sentMessages().find((message) => message.text.includes("Предложение:"))!;
    expect(proposal.text).toBe([
      "Предложение:",
      "Действие: изменить задачу",
      "Задача: task<U+2066>id<U+2069>",
      "Название: left<U+202E>right<U+200D><U+0001> next",
      "Проект: pro<U+2067>ject<U+2069><U+0085>",
      "Тип: development",
      "Статус: in_progress",
      "Срок: снять срок",
      "",
      "Подтвердить изменение?",
    ].join("\n"));
    expect(proposal.text.replace(/\n/gu, "")).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  it("renders every effective update field and explicit due-date removal", async () => {
    const { telegram } = await harness(async (_input, context) => {
      await context.tasks.propose({
        kind: "update",
        taskId: "task-update",
        expectedRevision: 3,
        patch: { title: "Новый заголовок", project: "PLAN", type: "development", status: "in_progress", dueDate: null },
      });
      return "Предложение подготовлено.";
    });
    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "update" });
    const proposal = telegram.sentMessages().find((message) => message.text.includes("Предложение:"))!;
    expect(proposal.text).toContain([
      "Действие: изменить задачу",
      "Задача: task-update",
      "Название: Новый заголовок",
      "Проект: PLAN",
      "Тип: development",
      "Статус: in_progress",
      "Срок: снять срок",
    ].join("\n"));
  });

  it.each([
    ["text" as const],
    ["voice" as const],
    ["file" as const],
  ])("keeps a task proposal available across a later %s message until confirmation", async (nextModality) => {
    let turn = 0;
    const { telegram, tasks } = await harness(async (_input, context) => {
      turn += 1;
      if (turn === 1) await context.tasks.propose({ kind: "create", title: "Keep proposal", project: "ASSISTANT", type: "operations" });
      return turn === 1 ? "Предложение подготовлено." : "Обычный ответ.";
    });
    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "create" });
    const proposal = telegram.sentMessages().find((message) => message.text.includes("Предложение:"))!;

    if (nextModality === "text") {
      await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "continue" });
    } else if (nextModality === "voice") {
      await telegram.sendVoice({ chatId: owner.chatId, userId: owner.userId, fileId: "voice-after-proposal", transcript: "continue", durationSeconds: 1 });
    } else {
      await telegram.sendFile({
        chatId: owner.chatId,
        userId: owner.userId,
        attachment: { fileId: "file-after-proposal", messageId: 99, payloadKind: "document", fileName: "note.txt", fileSizeBytes: 4, forwarded: false },
      });
    }

    expect(telegram.replyMarkupEditCalls()).not.toContainEqual({ chatId: owner.chatId, messageId: proposal.messageId, replyMarkup: undefined });
    await expect(tasks.list(owner.employeeId)).resolves.toEqual([]);
    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: taskButton(proposal, "✅ Подтвердить"), messageId: proposal.messageId, callbackQueryId: `confirm-after-${nextModality}` });
    expect(telegram.callbackAnswers().at(-1)?.text).toBe("Изменение сохранено.");
    await expect(tasks.list(owner.employeeId)).resolves.toMatchObject([{ title: "Keep proposal" }]);
  });

  it("keeps multiple pending task proposals independently actionable", async () => {
    let turn = 0;
    const { telegram, tasks } = await harness(async (_input, context) => {
      turn += 1;
      await context.tasks.propose({ kind: "create", title: `Proposal ${turn}`, project: "ASSISTANT", type: "operations" });
      return "Предложение подготовлено.";
    });
    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "first" });
    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "second" });
    const proposals = telegram.sentMessages().filter((message) => message.text.includes("Предложение:"));
    expect(proposals).toHaveLength(2);
    expect(telegram.replyMarkupEditCalls()).not.toContainEqual({ chatId: owner.chatId, messageId: proposals[0]!.messageId, replyMarkup: undefined });

    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: taskButton(proposals[0]!, "✅ Подтвердить"), messageId: proposals[0]!.messageId, callbackQueryId: "confirm-first" });
    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: taskButton(proposals[1]!, "✅ Подтвердить"), messageId: proposals[1]!.messageId, callbackQueryId: "confirm-second" });
    await expect(tasks.list(owner.employeeId)).resolves.toMatchObject([{ title: "Proposal 1" }, { title: "Proposal 2" }]);
  });

  it("keeps a terminal rejection stable when Telegram markup cleanup fails", async () => {
    const { telegram, tasks } = await harness(async (_input, context) => {
      await context.tasks.propose({ kind: "create", title: "Reject me", project: "ASSISTANT", type: "operations" });
      return "Предложение подготовлено.";
    });
    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "create" });
    const proposal = telegram.sentMessages().find((message) => message.text.includes("Предложение:"))!;
    const reject = taskButton(proposal, "❌ Отклонить");

    telegram.failNextReplyMarkupEdit();
    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: reject, messageId: proposal.messageId, callbackQueryId: "reject-1" });
    expect(telegram.callbackAnswers().at(-1)?.text).toBe("Предложение отклонено.");
    await expect(tasks.list(owner.employeeId)).resolves.toEqual([]);

    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: taskButton(proposal, "✅ Подтвердить"), messageId: proposal.messageId, callbackQueryId: "confirm-rejected" });
    expect(telegram.callbackAnswers().at(-1)?.text).toBe("Уже обработано.");
    await expect(tasks.list(owner.employeeId)).resolves.toEqual([]);
  });

  it("maps expired and missing proposals honestly without claiming a save", async () => {
    const { telegram, tasks, setNow } = await harness(async (_input, context) => {
      await context.tasks.propose({ kind: "create", title: "Stale", project: "ASSISTANT", type: "operations" });
      return "Предложение подготовлено.";
    });
    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "create" });
    const proposal = telegram.sentMessages().find((message) => message.text.includes("Предложение:"))!;
    setNow("2026-07-29T09:16:00.000Z");
    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: taskButton(proposal, "✅ Подтвердить"), messageId: proposal.messageId, callbackQueryId: "expired" });
    expect(telegram.callbackAnswers().at(-1)?.text).toBe("Срок подтверждения истёк. Изменение не выполнено.");
    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: "tm:c:missing-confirmation", messageId: proposal.messageId + 100, callbackQueryId: "missing" });
    expect(telegram.callbackAnswers().at(-1)?.text).toBe("Предложение не найдено. Изменение не выполнено.");
    await expect(tasks.list(owner.employeeId)).resolves.toEqual([]);
  });

  it("uses no-save wording for every terminal no-effect confirmation status", () => {
    expect(taskDecisionText({ status: "rejected" })).toBe("Предложение отклонено.");
    expect(taskDecisionText({ status: "already_rejected" })).toBe("Предложение уже отклонено.");
    expect(taskDecisionText({ status: "expired" })).toBe("Срок подтверждения истёк. Изменение не выполнено.");
    expect(taskDecisionText({ status: "not_found" })).toBe("Предложение не найдено. Изменение не выполнено.");
    expect(taskDecisionText({ status: "owner_mismatch" })).toBe("Предложение принадлежит другому владельцу. Изменение не выполнено.");
    expect(taskDecisionText({ status: "invalid_payload" })).toBe("Предложение повреждено или устарело. Изменение не выполнено.");
    expect(taskDecisionText({ status: "confirmed", outcome: { outcome: "not_found" } })).toBe("Задача не найдена. Изменение не выполнено.");
    expect(taskDecisionText({ status: "confirmed", outcome: { outcome: "conflict" } })).toBe("Задача изменилась после предложения. Обновите данные и создайте новое предложение.");
  });

  it("fails closed for a foreign Telegram user", async () => {
    const { telegram, tasks } = await harness(async (_input, context) => {
      await context.tasks.propose({ kind: "create", title: "Owner only", project: "ASSISTANT", type: "operations" });
      return "Предложение подготовлено.";
    });
    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "create" });
    const proposal = telegram.sentMessages().find((message) => message.text.includes("Предложение:"))!;
    await telegram.deliverCallback({ chatId: owner.chatId, userId: "foreign-user", callbackData: taskButton(proposal, "✅ Подтвердить"), messageId: proposal.messageId, callbackQueryId: "foreign" });
    expect(telegram.callbackAnswers().at(-1)?.text).toBe("Этот аккаунт не связан с данным чатом.");
    await expect(tasks.list(owner.employeeId)).resolves.toEqual([]);
  });
});
