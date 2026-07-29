import { describe, expect, it } from "vitest";
import type { AssistantAgentRunner } from "../../../src/application/assistant-service.js";
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

async function harness(runner: AssistantAgentRunner) {
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
  const telegram = new TelegramDriver(legacy.world, async () => "legacy", {}, true, undefined, { ...legacy, service: facade });
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
    expect(proposals[0]!.replyMarkup?.inlineKeyboard.flat().map(({ text }) => text)).toEqual(["✅ Подтвердить", "❌ Отклонить"]);
    expect(taskButton(proposals[0]!, "✅ Подтвердить")).toBe("tm:c:telegram-confirmation-1");
    await expect(tasks.list(owner.employeeId)).resolves.toEqual([]);

    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: taskButton(proposals[0]!, "✅ Подтвердить"), messageId: proposals[0]!.messageId, callbackQueryId: "confirm-1" });
    expect(telegram.callbackAnswers().at(-1)?.text).toBe("Изменение сохранено.");
    await expect(tasks.list(owner.employeeId)).resolves.toMatchObject([{ title: `Task from ${modality}` }]);
    expect(telegram.replyMarkupEditCalls()).toContainEqual({ chatId: owner.chatId, messageId: proposals[0]!.messageId, replyMarkup: undefined });

    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: taskButton(proposals[0]!, "✅ Подтвердить"), messageId: proposals[0]!.messageId, callbackQueryId: "confirm-2" });
    expect(telegram.callbackAnswers().at(-1)?.text).toBe("Уже обработано.");
    await expect(tasks.list(owner.employeeId)).resolves.toHaveLength(1);
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
