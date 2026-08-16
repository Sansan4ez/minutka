import { describe, expect, it } from "vitest";
import { AssistantService, type AssistantPendingAction } from "../../../src/application/assistant-service.js";
import { createInMemoryArtifactContentStore } from "../../../src/application/in-memory-artifact-content-store.js";
import { createInMemoryArtifactStore } from "../../../src/application/in-memory-artifact-store.js";
import { createInMemoryBlobStore } from "../../../src/application/in-memory-blob-store.js";
import { createInMemoryConversationStore } from "../../../src/application/in-memory-conversation-store.js";
import { createInMemoryDocumentStore } from "../../../src/application/in-memory-document-store.js";
import { createInMemoryIdeaStore } from "../../../src/application/in-memory-idea-store.js";
import { createInMemoryIdeaDeletionConfirmationStore } from "../../../src/application/in-memory-idea-deletion-confirmation-store.js";
import { createInMemoryTaskMutationConfirmationStore } from "../../../src/application/in-memory-task-mutation-confirmation-store.js";
import { createInMemoryContextDocumentConfirmationStore } from "../../../src/application/in-memory-context-document-confirmation-store.js";
import { createInMemoryTaskStore } from "../../../src/application/in-memory-task-store.js";
import { createIngestionService } from "../../../src/application/ingestion-service.js";
import { IdeaDeletionService } from "../../../src/application/idea-deletion.js";
import { PersonalAssistantService } from "../../../src/application/personal-assistant-service.js";
import { createDeterministicIdGenerator } from "../../../src/application/runtime-primitives.js";
import { TaskMutationConfirmationService } from "../../../src/application/task-mutation-confirmation.js";
import { ContextDocumentService } from "../../../src/application/context-document-service.js";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import { buildPendingActionGroupCard, maxTelegramMessageCharacters, taskDecisionText } from "../../../src/telegram/telegram-shell.js";
import { renderTelegramPlainText } from "../../../src/telegram/telegram-renderer.js";
import { TelegramDriver } from "../support/telegram-driver.js";
import { createDefaultSpecDeps } from "../support/scripted-deps.js";

const owner = { employeeId: "task-owner", inviteCode: "task-invite", chatId: "task-chat", userId: "task-user" };

async function harness(runner: ConstructorParameters<typeof AssistantService>[0]) {
  let now = "2026-07-29T09:00:00.000Z";
  const clock = { now: () => now };
  const legacy = createInMemoryRuntime({ agentRunner: async () => "legacy", deps: createDefaultSpecDeps() });
  legacy.world.now = clock.now;
  await legacy.service.issueInvite({ employeeId: owner.employeeId, inviteCode: owner.inviteCode, companyId: "default_company", groupId: "default_group" });
  await legacy.service.redeemTelegramInvite({ inviteCode: owner.inviteCode, identity: { chatId: owner.chatId, userId: owner.userId } });
  await legacy.service.acceptConsent({ employeeId: owner.employeeId, accepted: true, source: "test", telegramIdentity: { chatId: owner.chatId, userId: owner.userId } });
  await legacy.service.completeOnboarding({ roleId: "default_role", employeeId: owner.employeeId, selfDescription: "Owner", persona: "efficiency" });
  const documents = createInMemoryDocumentStore(clock);
  const ideas = createInMemoryIdeaStore(clock);
  const tasks = createInMemoryTaskStore(clock);
  const contextDocuments = new ContextDocumentService(
    documents, createInMemoryContextDocumentConfirmationStore(), clock,
    { confirmationId: (() => { let id = 0; return () => `telegram-context-document-${++id}`; })() },
  );
  const taskMutations = new TaskMutationConfirmationService(
    createInMemoryTaskMutationConfirmationStore(tasks), clock,
    { confirmationId: (() => { let id = 0; return () => `telegram-confirmation-${++id}`; })() },
  );
  const taskMutationProposals = { propose: taskMutations.propose.bind(taskMutations) };
  const ideaDeletions = new IdeaDeletionService(
    ideas, createInMemoryIdeaDeletionConfirmationStore(ideas), clock,
    { confirmationId: (() => { let id = 0; return () => `telegram-idea-deletion-${++id}`; })() },
  );
  const assistant = new AssistantService(runner, {
    documentStore: documents,
    conversationStore: createInMemoryConversationStore(legacy.world),
    ingestionService: createIngestionService({ documentStore: documents, blobStore: createInMemoryBlobStore(clock), ideaStore: ideas }),
    ideaStore: ideas, ideaDeletions, contextDocuments, taskStore: tasks, taskMutations: taskMutationProposals,
    requestIntegrityGuard: async () => ({ status: "allowed" }), clock, idGenerator: createDeterministicIdGenerator(),
  });
  const artifacts = createInMemoryArtifactStore({ contentStore: createInMemoryArtifactContentStore(clock), clock, limits: { maximumBytes: 1024, timeoutMs: 1_000 } });
  const facade = new PersonalAssistantService(legacy.service, assistant, artifacts, taskMutations, undefined, ideaDeletions, undefined, undefined, contextDocuments);
  const telegram = new TelegramDriver(legacy.world, async () => "legacy", {}, true, undefined, { ...legacy, service: facade }, { saveArtifact: (input) => facade.saveArtifact(input) });
  return { telegram, ideas, tasks, documents, contextDocuments, facade, pendingActionGroupStore: legacy.pendingActionGroupStore, setNow(value: string) { now = value; } };
}

function taskButton(message: ReturnType<TelegramDriver["sentMessages"]>[number], text: string): string {
  const button = message.replyMarkup?.inlineKeyboard.flat().find((candidate) => candidate.text === text);
  if (!button) throw new Error(`button ${text} not found`);
  return button.callbackData;
}

function oversizedPendingActions(): AssistantPendingAction[] {
  const longText = "🙂".repeat(278);
  return Array.from({ length: 5 }, (_, index) => ({
    confirmationId: `oversized-confirmation-${index + 1}`,
    actionKind: "create" as const,
    summary: `Предложение ${index + 1}`,
    expiresAt: "2026-07-29T09:15:00.000Z",
    preview: {
      kind: "create" as const,
      title: { value: `${index + 1}-${longText}`, truncated: false },
      project: { value: `${index + 1}-${longText}`, truncated: false },
      type: "operations" as const,
      dueDate: "2026-08-10",
    },
  }));
}

function proactiveResult(pendingActions: AssistantPendingAction[]) {
  return {
    messageId: "oversized-message",
    response: "Предложения подготовлены.",
    selectedProcessIds: [],
    outcome: { status: "completed" as const },
    pendingActions,
    effect: "pending_action_created" as const,
  };
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
    expect(telegram.sentMessages().map(({ text }) => text)).not.toContain("Предложение подготовлено.");
    await expect(tasks.list(owner.employeeId)).resolves.toEqual([]);

    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: taskButton(proposals[0]!, "✅ Подтвердить"), messageId: proposals[0]!.messageId, callbackQueryId: "confirm-1" });
    expect(telegram.callbackAnswers().at(-1)?.text).toBe("Изменение сохранено.");
    await expect(tasks.list(owner.employeeId)).resolves.toMatchObject([{ title: `Task from ${modality}` }]);
    expect(telegram.replyMarkupEditCalls()).toContainEqual({ chatId: owner.chatId, messageId: proposals[0]!.messageId, replyMarkup: undefined });

    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: taskButton(proposals[0]!, "✅ Подтвердить"), messageId: proposals[0]!.messageId, callbackQueryId: "confirm-2" });
    expect(telegram.callbackAnswers().at(-1)?.text).toBe("Уже обработано.");
    await expect(tasks.list(owner.employeeId)).resolves.toHaveLength(1);
  });

  it("confirms a level-1 cancellation by explicit text, removes the keyboard, and keeps a later button press idempotent", async () => {
    let turns = 0;
    const { telegram, tasks } = await harness(async (_input, context) => {
      turns += 1;
      const [task] = await context.tasks.list();
      await context.tasks.propose({ kind: "cancel", taskId: task!.id });
      return "Отменить задачу?";
    });
    await tasks.create(owner.employeeId, { id: "task-to-cancel", title: "Отменить меня", project: "ASSISTANT", type: "operations", status: "open" });

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "отмени задачу" });
    const proposal = telegram.sentMessages().find((message) => message.text.includes("Действие: отменить задачу"))!;
    const confirmButton = taskButton(proposal, "✅ Подтвердить");
    expect(proposal.text).toContain("Скажите «да» или нажмите кнопку.");

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "ДА!" });
    expect(turns).toBe(1);
    expect(telegram.sentMessages().at(-1)?.text).toBe("Изменение сохранено.");
    expect(telegram.replyMarkupEditCalls()).toContainEqual({ chatId: owner.chatId, messageId: proposal.messageId, replyMarkup: undefined });
    await expect(tasks.get(owner.employeeId, "task-to-cancel")).resolves.toMatchObject({ status: "cancelled" });

    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: confirmButton, messageId: proposal.messageId, callbackQueryId: "confirm-after-text" });
    expect(telegram.callbackAnswers().at(-1)?.text).toBe("Изменение уже сохранено.");
    await expect(tasks.get(owner.employeeId, "task-to-cancel")).resolves.toMatchObject({ status: "cancelled" });
  });

  it("rejects a level-1 cancellation by explicit text", async () => {
    let turns = 0;
    const { telegram, tasks } = await harness(async (_input, context) => {
      turns += 1;
      const [task] = await context.tasks.list();
      await context.tasks.propose({ kind: "cancel", taskId: task!.id });
      return "Отменить задачу?";
    });
    await tasks.create(owner.employeeId, { id: "task-to-keep", title: "Оставить меня", project: "ASSISTANT", type: "operations", status: "open" });

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "отмени задачу" });
    const proposal = telegram.sentMessages().find((message) => message.text.includes("Действие: отменить задачу"))!;
    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "нет" });

    expect(turns).toBe(1);
    expect(telegram.sentMessages().at(-1)?.text).toBe("Предложение отклонено.");
    expect(telegram.replyMarkupEditCalls()).toContainEqual({ chatId: owner.chatId, messageId: proposal.messageId, replyMarkup: undefined });
    await expect(tasks.get(owner.employeeId, "task-to-keep")).resolves.toMatchObject({ status: "open" });
  });

  it("sends an ambiguous reply to the agent and keeps the pending action available", async () => {
    let turns = 0;
    const { telegram, tasks } = await harness(async (input, context) => {
      turns += 1;
      if (turns === 1) {
        const [task] = await context.tasks.list();
        await context.tasks.propose({ kind: "cancel", taskId: task!.id });
        return "Отменить задачу?";
      }
      return `Обычный ответ: ${input.text}`;
    });
    await tasks.create(owner.employeeId, { id: "task-still-pending", title: "Пока оставить", project: "ASSISTANT", type: "operations", status: "open" });

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "отмени задачу" });
    const proposal = telegram.sentMessages().find((message) => message.text.includes("Действие: отменить задачу"))!;
    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "да, но сначала проверь проект" });

    expect(turns).toBe(2);
    expect(telegram.sentMessages().at(-1)?.text).toBe("Обычный ответ: да, но сначала проверь проект");
    expect(telegram.replyMarkupEditCalls()).not.toContainEqual({ chatId: owner.chatId, messageId: proposal.messageId, replyMarkup: undefined });
    await expect(tasks.get(owner.employeeId, "task-still-pending")).resolves.toMatchObject({ status: "open" });

    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: taskButton(proposal, "✅ Подтвердить"), messageId: proposal.messageId, callbackQueryId: "confirm-after-ambiguous" });
    await expect(tasks.get(owner.employeeId, "task-still-pending")).resolves.toMatchObject({ status: "cancelled" });
  });

  it("never treats decision text as confirmation without an active pending action", async () => {
    let turns = 0;
    const { telegram } = await harness(async (input) => {
      turns += 1;
      return `Обычный ответ: ${input.text}`;
    });

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "да" });

    expect(turns).toBe(1);
    expect(telegram.sentMessages().at(-1)?.text).toBe("Обычный ответ: да");
  });

  it("does not resolve a pending action from an unlinked account", async () => {
    let turns = 0;
    const { telegram, tasks } = await harness(async (_input, context) => {
      turns += 1;
      const [task] = await context.tasks.list();
      await context.tasks.propose({ kind: "cancel", taskId: task!.id });
      return "Отменить задачу?";
    });
    await tasks.create(owner.employeeId, { id: "task-owner-only", title: "Только владелец", project: "ASSISTANT", type: "operations", status: "open" });

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "отмени задачу" });
    await telegram.sendText({ chatId: owner.chatId, userId: "foreign-user", text: "да" });

    expect(turns).toBe(1);
    expect(telegram.sentMessages().at(-1)?.text).toBe("Этот аккаунт не связан с данным чатом.");
    await expect(tasks.get(owner.employeeId, "task-owner-only")).resolves.toMatchObject({ status: "open" });
  });

  it("delivers a scheduled pending action with confirmation buttons and applies it through the normal callback path", async () => {
    const { telegram, tasks, facade } = await harness(async (_input, context) => {
      await context.tasks.propose({ kind: "create", title: "Scheduled task", project: "ASSISTANT", type: "operations" });
      return "Запланированное предложение подготовлено.";
    });
    const result = await facade.runScheduledProcess({ userId: owner.employeeId, threadId: owner.employeeId, processId: "day_focus" });
    await telegram.deliverProactive({ chatId: owner.chatId, employeeId: owner.employeeId, result });

    const proposal = telegram.sentMessages().find((message) => message.text.includes("Предложение:"))!;
    expect(proposal.replyMarkup?.inlineKeyboard.flat().map(({ text }) => text)).toEqual(["✅ Подтвердить", "❌ Отклонить"]);
    expect(telegram.sentMessages().map(({ text }) => text)).not.toContain("Запланированное предложение подготовлено.");
    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: taskButton(proposal, "✅ Подтвердить"), messageId: proposal.messageId, callbackQueryId: "confirm-scheduled" });
    expect(telegram.callbackAnswers().at(-1)?.text).toBe("Изменение сохранено.");
    await expect(tasks.list(owner.employeeId)).resolves.toMatchObject([{ title: "Scheduled task" }]);
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
    expect(telegram.sentMessages().map(({ text }) => text)).not.toContain("Предложение подготовлено.");
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

  it("suppresses model-authored confirmation narration with opaque ids", async () => {
    const leakedNarration = [
      "Подготовил закрытие задачи через подтверждение.",
      "ID: task_fd7e2e5f-04e9-4b1f-bddb-a795628033d0",
      "Теперь подтверди действие в интерфейсе:",
      "task-confirmation-5338218f-327c-4582-9a45-3f93e3c87bd3",
    ].join("\n");
    const { telegram, tasks } = await harness(async (_input, context) => {
      await context.tasks.propose({ kind: "create", title: "Visible card only", project: "ASSISTANT", type: "operations" });
      return leakedNarration;
    });

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "create" });

    const messages = telegram.sentMessages();
    expect(messages.filter((message) => message.text.includes("Предложение:"))).toHaveLength(1);
    expect(messages.map(({ text }) => text)).not.toContain(leakedNarration);
    expect(messages.every(({ text }) => !text.includes("task_fd7e2e5f") && !text.includes("task-confirmation-5338218f") && !text.includes("интерфейсе"))).toBe(true);
    await expect(tasks.list(owner.employeeId)).resolves.toEqual([]);
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

  it("offers to supplement a retrieved thematic document before creating a duplicate note", async () => {
    const { telegram, documents } = await harness(async (_input, context) => {
      const search = await context.documents.searchDocuments({ query: "бассейн", limit: 5 });
      const match = search.matches[0];
      if (!match) throw new Error("expected thematic match");
      await context.documents.readDocument({ path: match.path });
      return `Нашёл ${match.path}. Дополнить его или сохранить отдельную заметку рядом в 30_knowledge?`;
    });
    await documents.put(owner.employeeId, "context/30_knowledge/pool.md", "# Бассейн\n\nТренировки");

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "сохрани заметку про бассейн" });

    expect(telegram.sentMessages().at(-1)?.text).toContain("/proc/context/30_knowledge/pool.md");
    expect(telegram.sentMessages().at(-1)?.text).toContain("Дополнить его или сохранить отдельную");
    expect(telegram.sentMessages().some((message) => message.text.includes("Предложение:"))).toBe(false);
    await expect(documents.listExact(owner.employeeId, "context/")).resolves.toHaveLength(1);
  });

  it("creates an explicitly separate context note in a related section and reports its logical neighbor", async () => {
    const { telegram, documents } = await harness(async (_input, context) => {
      const search = await context.documents.searchDocuments({ query: "бассейн", limit: 5 });
      const neighbor = search.matches[0]?.path;
      const saved = await context.contextDocuments.createNote({
        title: "Сон после бассейна",
        content: "# Сон после бассейна\n\nСон был спокойный",
        destination: "30_knowledge",
      });
      return saved.outcome === "created"
        ? `Сохранено: ${saved.path}, рядом с ${neighbor}. Можно восстановить предыдущую версию.`
        : "Заметка уже существует.";
    });
    await documents.put(owner.employeeId, "context/30_knowledge/pool.md", "# Бассейн\n\nТренировки");

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "сохрани как отдельную" });

    const response = telegram.sentMessages().at(-1)?.text ?? "";
    expect(response).toContain("/proc/context/30_knowledge/сон-после-бассейна.md");
    expect(response).toContain("рядом с /proc/context/30_knowledge/pool.md");
    expect(response).not.toMatch(/owner|object|bucket|confirmation/);
    expect(telegram.sentMessages().some((message) => message.text.includes("Предложение:"))).toBe(false);
    await expect(documents.get(owner.employeeId, "context/30_knowledge/сон-после-бассейна.md")).resolves.toMatchObject({
      content: "# Сон после бассейна\n\nСон был спокойный",
    });
  });

  it("renders a bounded context-document diff and confirms it exactly once", async () => {
    let originalVersion = "";
    const { telegram, documents } = await harness(async (_input, context) => {
      const current = await context.documents.readDocument({ path: "/proc/context/00_inbox/source.md" });
      originalVersion = current.version;
      await context.contextDocuments.proposeUpdate({
        path: current.path,
        expectedVersion: current.version,
        patch: { search: "old text", replacement: "new text" },
      });
      return "Предложение подготовлено.";
    });
    await documents.put(owner.employeeId, "context/00_inbox/source.md", "# Source\n\nold text");

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "замени раздел" });

    const proposal = telegram.sentMessages().find((message) => message.text.includes("Предложение:"))!;
    expect(proposal.text).toContain("Действие: изменить документ\nДокумент: /proc/context/00_inbox/source.md\nУдаляется: - old text\nДобавляется: + new text");
    expect(taskButton(proposal, "✅ Подтвердить")).toBe("cd:c:telegram-context-document-1");
    await expect(documents.get(owner.employeeId, "context/00_inbox/source.md")).resolves.toMatchObject({ content: "# Source\n\nold text", version: originalVersion });

    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: taskButton(proposal, "✅ Подтвердить"), messageId: proposal.messageId, callbackQueryId: "confirm-context" });
    expect(telegram.callbackAnswers().at(-1)?.text).toBe("Изменение документа сохранено.");
    await expect(documents.get(owner.employeeId, "context/00_inbox/source.md")).resolves.toMatchObject({ content: "# Source\n\nnew text" });

    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: taskButton(proposal, "✅ Подтвердить"), messageId: proposal.messageId, callbackQueryId: "confirm-context-again" });
    expect(telegram.callbackAnswers().at(-1)?.text).toBe("Уже обработано.");
  });

  it("confirms a level-1 context-document move by explicit text", async () => {
    const { telegram, documents } = await harness(async (_input, context) => {
      const current = await context.documents.readDocument({ path: "/proc/context/00_inbox/move-source.md" });
      await context.contextDocuments.proposeMove({
        path: current.path,
        destination: "/proc/context/00_inbox/move-destination.md",
        expectedVersion: current.version,
      });
      return "Переместить документ?";
    });
    await documents.put(owner.employeeId, "context/00_inbox/move-source.md", "move me");

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "перемести документ" });
    const proposal = telegram.sentMessages().find((message) => message.text.includes("Действие: переименовать/переместить документ"))!;
    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "да" });

    expect(telegram.sentMessages().at(-1)?.text).toBe("Изменение документа сохранено.");
    expect(telegram.replyMarkupEditCalls()).toContainEqual({ chatId: owner.chatId, messageId: proposal.messageId, replyMarkup: undefined });
    await expect(documents.get(owner.employeeId, "context/00_inbox/move-source.md")).resolves.toBeNull();
    await expect(documents.get(owner.employeeId, "context/00_inbox/move-destination.md")).resolves.toMatchObject({ content: "move me" });
  });

  it("terminally rejects an undeliverable context-document proposal", async () => {
    const { telegram, documents } = await harness(async (_input, context) => {
      const current = await context.documents.readDocument({ path: "/proc/context/00_inbox/source.md" });
      await context.contextDocuments.proposeDelete({ path: current.path, expectedVersion: current.version });
      return "Предложение подготовлено.";
    });
    await documents.put(owner.employeeId, "context/00_inbox/source.md", "keep me");
    telegram.setMessageDeliverySequence("fail", "fail");

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "удали документ" });

    expect(telegram.taskMutationRejectCalls()).toEqual(["telegram-context-document-1"]);
    expect(telegram.sentMessages().at(-1)?.text).toBe("Не удалось доставить предложение. Оно отменено; создайте новое предложение позже.");
    await expect(documents.get(owner.employeeId, "context/00_inbox/source.md")).resolves.toMatchObject({ content: "keep me" });
  });

  it("renders an idea deletion without its opaque id and confirms it exactly once", async () => {
    const ideaId = "idea_fd7e2e5f-04e9-4b1f-bddb-a795628033d0";
    const summary = "Черновик партнёрского предложения";
    const { telegram, ideas, facade } = await harness(async (_input, context) => {
      const idea = await ideas.get(owner.employeeId, ideaId);
      if (!idea) throw new Error("expected idea");
      await context.ideas.propose({ ideaId: idea.id, expectedRevision: idea.revision });
      return `Подготовил удаление ${ideaId}`;
    });
    await ideas.add({ id: ideaId, userId: owner.employeeId, project: "ASSISTANT", type: "knowledge", summary, status: "raw" });

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "delete idea" });

    const proposal = telegram.sentMessages().find((message) => message.text.includes("Предложение:"))!;
    expect(proposal.text).toContain(`Действие: удалить идею\nИдея: ${summary}`);
    expect(proposal.text).not.toContain(ideaId);
    expect(proposal.text).not.toContain("ID:");
    expect(taskButton(proposal, "✅ Подтвердить")).toBe("id:c:telegram-idea-deletion-1");
    expect(taskButton(proposal, "❌ Отклонить")).toBe("id:r:telegram-idea-deletion-1");

    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: taskButton(proposal, "✅ Подтвердить"), messageId: proposal.messageId, callbackQueryId: "confirm-idea" });
    expect(telegram.callbackAnswers().at(-1)?.text).toBe("Идея удалена. Можно отменить удаление командой «верни последнюю идею».");
    await expect(ideas.get(owner.employeeId, ideaId)).resolves.toBeNull();

    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: taskButton(proposal, "✅ Подтвердить"), messageId: proposal.messageId, callbackQueryId: "confirm-idea-again" });
    expect(telegram.callbackAnswers().at(-1)?.text).toBe("Уже обработано.");
    await expect(facade.undoIdeaDeletion(owner.employeeId)).resolves.toMatchObject({ outcome: "restored", idea: { id: ideaId } });
    await expect(facade.undoIdeaDeletion(owner.employeeId, ideaId)).resolves.toMatchObject({ outcome: "unchanged", idea: { id: ideaId } });
  });

  it("confirms an idea deletion by explicit text", async () => {
    const ideaId = "idea_text_confirmation";
    const { telegram, ideas } = await harness(async (_input, context) => {
      const idea = await ideas.get(owner.employeeId, ideaId);
      if (!idea) throw new Error("expected idea");
      await context.ideas.propose({ ideaId: idea.id, expectedRevision: idea.revision });
      return "Удалить идею?";
    });
    await ideas.add({ id: ideaId, userId: owner.employeeId, project: "ASSISTANT", type: "knowledge", summary: "Удалить словами", status: "raw" });

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "удали идею" });
    const proposal = telegram.sentMessages().find((message) => message.text.includes("Идея: Удалить словами"))!;
    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "подтверждаю" });

    expect(telegram.sentMessages().at(-1)?.text).toBe("Идея удалена. Можно отменить удаление командой «верни последнюю идею».");
    expect(telegram.replyMarkupEditCalls()).toContainEqual({ chatId: owner.chatId, messageId: proposal.messageId, replyMarkup: undefined });
    await expect(ideas.get(owner.employeeId, ideaId)).resolves.toBeNull();
  });

  it("uses a neutral fallback for an invisible idea summary and rejects it exactly once", async () => {
    const ideaId = "idea_hidden_summary_42";
    const { telegram, ideas } = await harness(async (_input, context) => {
      const idea = await ideas.get(owner.employeeId, ideaId);
      if (!idea) throw new Error("expected idea");
      await context.ideas.propose({ ideaId: idea.id, expectedRevision: idea.revision });
      return "Предложение подготовлено.";
    });
    await ideas.add({ id: ideaId, userId: owner.employeeId, project: "ASSISTANT", type: "knowledge", summary: "\u2066\u2069", status: "raw" });

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "delete invisible idea" });

    const proposal = telegram.sentMessages().find((message) => message.text.includes("Предложение:"))!;
    expect(proposal.text).toContain("Действие: удалить идею\nИдея: Идея без описания");
    expect(proposal.text).not.toContain(ideaId);
    expect(proposal.text).not.toContain("U+2066");
    expect(proposal.text).not.toContain("U+2069");

    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: taskButton(proposal, "❌ Отклонить"), messageId: proposal.messageId, callbackQueryId: "reject-idea" });
    expect(telegram.callbackAnswers().at(-1)?.text).toBe("Удаление отменено.");
    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: taskButton(proposal, "❌ Отклонить"), messageId: proposal.messageId, callbackQueryId: "reject-idea-again" });
    expect(telegram.callbackAnswers().at(-1)?.text).toBe("Уже обработано.");
    await expect(ideas.get(owner.employeeId, ideaId)).resolves.toMatchObject({ revision: 1 });
  });

  it("renders unsafe task text as inert tokens without allowing labels or field boundaries to be reordered", async () => {
    const unsafeTaskId = "task\u2066id\u2069";
    const unsafeTitle = "left\u202Eright\u200D\u0001\nnext";
    const unsafeProject = "pro\u2067ject\u2069\u0085";
    const { telegram, tasks } = await harness(async (_input, context) => {
      await context.tasks.propose({
        kind: "update",
        taskId: unsafeTaskId,
        expectedRevision: 1,
        patch: { title: unsafeTitle, project: unsafeProject, type: "development", status: "in_progress", dueDate: null },
      });
      return "Предложение подготовлено.";
    });
    await tasks.create(owner.employeeId, { id: unsafeTaskId, title: unsafeTitle, project: "OLD", type: "operations", status: "open" });

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "unsafe update" });

    const proposal = telegram.sentMessages().find((message) => message.text.includes("Предложение:"))!;
    expect(proposal.text).toBe([
      "Предложение:",
      "Действие: изменить задачу",
      "Задача: left&lt;U+202E&gt;right&lt;U+200D&gt;&lt;U+0001&gt; next",
      "Название: left&lt;U+202E&gt;right&lt;U+200D&gt;&lt;U+0001&gt; next",
      "Проект: pro&lt;U+2067&gt;ject&lt;U+2069&gt;&lt;U+0085&gt;",
      "Тип: development",
      "Статус: in_progress",
      "Срок: снять срок",
      "",
      "Подтвердить изменение?",
    ].join("\n"));
    expect(proposal.text.replace(/\n/gu, "")).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  });

  it.each([
    ["complete" as const, "завершить задачу"],
    ["cancel" as const, "отменить задачу"],
  ])("renders the human task title and no opaque ids for %s", async (kind, actionLabel) => {
    const taskId = "task_fd7e2e5f-04e9-4b1f-bddb-a795628033d0";
    const title = "Сходить в магазин в 14:00";
    const { telegram, tasks } = await harness(async (_input, context) => {
      await context.tasks.propose({ kind, taskId, expectedRevision: 1 });
      return `Подготовил действие для ${taskId} через task-confirmation-hidden`;
    });
    await tasks.create(owner.employeeId, { id: taskId, title, project: "личное", type: "personal", status: "open" });

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: kind });

    const proposal = telegram.sentMessages().find((message) => message.text.includes("Предложение:"))!;
    expect(proposal.text).toContain(`Действие: ${actionLabel}\nЗадача: ${title}`);
    expect(proposal.text).not.toContain(taskId);
    expect(proposal.text).not.toContain("task-confirmation");
    expect(telegram.sentMessages()).toHaveLength(1);
  });

  it("renders every effective update field and explicit due-date removal", async () => {
    const { telegram, tasks } = await harness(async (_input, context) => {
      await context.tasks.propose({
        kind: "update",
        taskId: "task-update",
        expectedRevision: 1,
        patch: { title: "Новый заголовок", project: "PLAN", type: "development", status: "in_progress", dueDate: null },
      });
      return "Предложение подготовлено.";
    });
    await tasks.create(owner.employeeId, { id: "task-update", title: "Старый заголовок", project: "OLD", type: "operations", status: "open" });
    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "update" });
    const proposal = telegram.sentMessages().find((message) => message.text.includes("Предложение:"))!;
    expect(proposal.text).toContain([
      "Действие: изменить задачу",
      "Задача: Старый заголовок",
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

  it("bounds worst-case grouped previews to one stable owner-visible Telegram card", () => {
    const actions = oversizedPendingActions();
    const card = buildPendingActionGroupCard(actions, maxTelegramMessageCharacters);

    expect(renderTelegramPlainText(card.text)).toHaveLength(1);
    expect(card.shown.length).toBeGreaterThanOrEqual(1);
    expect(card.omitted.length).toBeGreaterThan(0);
    expect(card.text).toContain(`Показано ${card.shown.length} из 5; остальные предложения не показаны.`);
    expect(card.shown.map(({ confirmationId }) => confirmationId)).toEqual(actions.slice(0, card.shown.length).map(({ confirmationId }) => confirmationId));
    expect(card.omitted.map(({ confirmationId }) => confirmationId)).toEqual(actions.slice(card.shown.length).map(({ confirmationId }) => confirmationId));
  });

  it("delivers an oversized group once and addresses only the shown proposals", async () => {
    const actions = oversizedPendingActions();
    const card = buildPendingActionGroupCard(actions, maxTelegramMessageCharacters);
    const { telegram } = await harness(async () => "legacy");

    await telegram.deliverProactive({ chatId: owner.chatId, employeeId: owner.employeeId, result: proactiveResult(actions) });

    expect(telegram.messageDeliveryAttempts()).toHaveLength(1);
    const proposal = telegram.sentMessages().at(-1)!;
    expect(proposal.text).toBe(card.text);
    expect(proposal.text).not.toMatch(/отклонен|отменен/iu);
    expect(telegram.taskMutationRejectCalls()).toEqual([]);

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "пятое — да" });
    expect(telegram.taskMutationConfirmCalls()).toEqual([]);

    await telegram.deliverCallback({
      chatId: owner.chatId,
      userId: owner.userId,
      callbackData: taskButton(proposal, "✅ Подтвердить всё"),
      messageId: proposal.messageId,
      callbackQueryId: "confirm-bounded-group",
    });
    expect(telegram.taskMutationConfirmCalls()).toEqual(card.shown.map(({ confirmationId }) => confirmationId));
    expect(telegram.taskMutationConfirmCalls()).not.toContain(card.omitted[0]!.confirmationId);
  });

  it("rejects only shown proposals when bounded group delivery fails", async () => {
    const actions = oversizedPendingActions();
    const card = buildPendingActionGroupCard(actions, maxTelegramMessageCharacters);
    const { telegram } = await harness(async () => "legacy");
    telegram.setMessageDeliverySequence("fail", "fail");

    await telegram.deliverProactive({ chatId: owner.chatId, employeeId: owner.employeeId, result: proactiveResult(actions) });

    expect(telegram.messageDeliveryAttempts()).toHaveLength(3);
    expect(telegram.messageDeliveryAttempts().slice(0, 2).map(({ text }) => text)).toEqual([card.text, card.text]);
    expect(telegram.taskMutationRejectCalls()).toEqual(card.shown.map(({ confirmationId }) => confirmationId));
    expect(telegram.taskMutationRejectCalls()).not.toContain(card.omitted[0]!.confirmationId);
    expect(telegram.sentMessages().at(-1)?.text).toContain("остальные предложения не отклонены");
  });

  it("renders one grouped card and confirms every canonical proposal with one gesture", async () => {
    const { telegram, tasks } = await harness(async (_input, context) => {
      await context.tasks.propose({ kind: "cancel", taskId: "group-task-1" });
      await context.tasks.propose({ kind: "cancel", taskId: "group-task-2" });
      return "Предложения подготовлены.";
    });
    await tasks.create(owner.employeeId, { id: "group-task-1", title: "Первое", project: "ASSISTANT", type: "operations", status: "open" });
    await tasks.create(owner.employeeId, { id: "group-task-2", title: "Второе", project: "ASSISTANT", type: "operations", status: "open" });

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "отмени обе" });
    const proposal = telegram.sentMessages().find((message) => message.text.includes("Предложения:"))!;
    expect(proposal.text).toContain("1. Действие: отменить задачу");
    expect(proposal.text).toContain("2. Действие: отменить задачу");
    expect(proposal.replyMarkup?.inlineKeyboard.flat().map(({ text }) => text)).toEqual(["✅ Подтвердить всё", "❌ Отклонить всё"]);

    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: taskButton(proposal, "✅ Подтвердить всё"), messageId: proposal.messageId, callbackQueryId: "confirm-group" });
    await expect(tasks.get(owner.employeeId, "group-task-1")).resolves.toMatchObject({ status: "cancelled" });
    await expect(tasks.get(owner.employeeId, "group-task-2")).resolves.toMatchObject({ status: "cancelled" });
    expect(telegram.sentMessages().at(-1)?.text).toContain("1. Изменение сохранено.");
    expect(telegram.sentMessages().at(-1)?.text).toContain("2. Изменение сохранено.");

    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: taskButton(proposal, "✅ Подтвердить всё"), messageId: proposal.messageId, callbackQueryId: "confirm-group-again" });
    expect(telegram.callbackAnswers().at(-1)?.text).toBe("Уже обработано.");
    await expect(tasks.list(owner.employeeId)).resolves.toHaveLength(2);
  });

  it("recovers a delivered group callback after shell restart", async () => {
    const { telegram, tasks } = await harness(async (_input, context) => {
      await context.tasks.propose({ kind: "cancel", taskId: "restart-callback-1" });
      await context.tasks.propose({ kind: "cancel", taskId: "restart-callback-2" });
      return "Предложения подготовлены.";
    });
    await tasks.create(owner.employeeId, { id: "restart-callback-1", title: "Первое", project: "ASSISTANT", type: "operations", status: "open" });
    await tasks.create(owner.employeeId, { id: "restart-callback-2", title: "Второе", project: "ASSISTANT", type: "operations", status: "open" });

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "отмени обе" });
    const proposal = telegram.sentMessages().find((message) => message.text.includes("Предложения:"))!;
    telegram.restartShell();

    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: taskButton(proposal, "✅ Подтвердить всё"), messageId: proposal.messageId, callbackQueryId: "restart-confirm-group" });
    await expect(tasks.get(owner.employeeId, "restart-callback-1")).resolves.toMatchObject({ status: "cancelled" });
    await expect(tasks.get(owner.employeeId, "restart-callback-2")).resolves.toMatchObject({ status: "cancelled" });
    expect(telegram.callbackAnswers().at(-1)?.text).toBe("Группа обработана.");
  });

  it("recovers the latest delivered group for a text decision after shell restart", async () => {
    const { telegram, tasks } = await harness(async (_input, context) => {
      await context.tasks.propose({ kind: "cancel", taskId: "restart-text-1" });
      await context.tasks.propose({ kind: "cancel", taskId: "restart-text-2" });
      return "Предложения подготовлены.";
    });
    await tasks.create(owner.employeeId, { id: "restart-text-1", title: "Первое", project: "ASSISTANT", type: "operations", status: "open" });
    await tasks.create(owner.employeeId, { id: "restart-text-2", title: "Второе", project: "ASSISTANT", type: "operations", status: "open" });

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "отмени обе" });
    telegram.restartShell();
    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "да" });

    await expect(tasks.get(owner.employeeId, "restart-text-1")).resolves.toMatchObject({ status: "cancelled" });
    await expect(tasks.get(owner.employeeId, "restart-text-2")).resolves.toMatchObject({ status: "cancelled" });
    expect(telegram.sentMessages().at(-1)?.text).toContain("1. Изменение сохранено.");
  });

  it("does not resolve a preparing group by text but binds its original callback after restart", async () => {
    let turns = 0;
    const { telegram, tasks, facade, pendingActionGroupStore } = await harness(async (_input, context) => {
      turns += 1;
      if (turns === 1) {
        await context.tasks.propose({ kind: "cancel", taskId: "preparing-callback-1" });
        await context.tasks.propose({ kind: "cancel", taskId: "preparing-callback-2" });
      }
      return "Обычный ответ.";
    });
    await tasks.create(owner.employeeId, { id: "preparing-callback-1", title: "Первое", project: "ASSISTANT", type: "operations", status: "open" });
    await tasks.create(owner.employeeId, { id: "preparing-callback-2", title: "Второе", project: "ASSISTANT", type: "operations", status: "open" });
    const chat = await facade.chat({ userId: owner.employeeId, threadId: "preparing-thread", text: "prepare", responseChannel: "telegram" });
    await pendingActionGroupStore.create({
      groupId: "cccccccccccccccccccccccc",
      ownerId: owner.employeeId,
      items: chat.pendingActions.map((action, index) => ({ ordinal: (index + 1) as 1 | 2, action, state: "pending" as const })),
      createdAt: "2026-07-29T09:00:00.000Z",
      expiresAt: "2026-07-29T09:15:00.000Z",
    });
    telegram.restartShell();

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "да" });
    await expect(tasks.get(owner.employeeId, "preparing-callback-1")).resolves.toMatchObject({ status: "open" });
    await expect(tasks.get(owner.employeeId, "preparing-callback-2")).resolves.toMatchObject({ status: "open" });

    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: "gp:c:cccccccccccccccccccccccc", messageId: 77, callbackQueryId: "bind-preparing-group" });
    await expect(tasks.get(owner.employeeId, "preparing-callback-1")).resolves.toMatchObject({ status: "cancelled" });
    await expect(tasks.get(owner.employeeId, "preparing-callback-2")).resolves.toMatchObject({ status: "cancelled" });
    await expect(pendingActionGroupStore.get(owner.employeeId, "cccccccccccccccccccccccc")).resolves.toMatchObject({ state: "completed", messageId: 77 });
  });

  it("rejects every pending record when a grouped card cannot be delivered", async () => {
    const { telegram, tasks } = await harness(async (_input, context) => {
      await context.tasks.propose({ kind: "cancel", taskId: "delivery-task-1" });
      await context.tasks.propose({ kind: "cancel", taskId: "delivery-task-2" });
      return "Предложения подготовлены.";
    });
    await tasks.create(owner.employeeId, { id: "delivery-task-1", title: "Первое", project: "ASSISTANT", type: "operations", status: "open" });
    await tasks.create(owner.employeeId, { id: "delivery-task-2", title: "Второе", project: "ASSISTANT", type: "operations", status: "open" });
    telegram.setMessageDeliverySequence("fail", "fail");

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "отмени обе" });

    expect(telegram.taskMutationRejectCalls()).toEqual(["telegram-confirmation-1", "telegram-confirmation-2"]);
    expect(telegram.sentMessages().at(-1)?.text).toBe("Не удалось доставить предложение. Оно отменено; создайте новое предложение позже.");
    await expect(tasks.get(owner.employeeId, "delivery-task-1")).resolves.toMatchObject({ status: "open" });
    await expect(tasks.get(owner.employeeId, "delivery-task-2")).resolves.toMatchObject({ status: "open" });
  });

  it("reports every result and keeps a failed middle group item isolated", async () => {
    const { telegram, tasks } = await harness(async (_input, context) => {
      await context.tasks.propose({ kind: "cancel", taskId: "failure-task-1" });
      await context.tasks.propose({ kind: "cancel", taskId: "failure-task-2" });
      return "Предложения подготовлены.";
    });
    await tasks.create(owner.employeeId, { id: "failure-task-1", title: "Первое", project: "ASSISTANT", type: "operations", status: "open" });
    await tasks.create(owner.employeeId, { id: "failure-task-2", title: "Второе", project: "ASSISTANT", type: "operations", status: "open" });

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "отмени обе" });
    await tasks.delete(owner.employeeId, "failure-task-2", { expectedRevision: 1 });
    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "да" });

    await expect(tasks.get(owner.employeeId, "failure-task-1")).resolves.toMatchObject({ status: "cancelled" });
    expect(telegram.sentMessages().at(-1)?.text).toContain("1. Изменение сохранено.");
    expect(telegram.sentMessages().at(-1)?.text).toContain("2. Задача не найдена. Изменение не выполнено.");
  });

  it("keeps original ordinals across partial group decisions and lists unresolved items", async () => {
    const { telegram, tasks } = await harness(async (_input, context) => {
      await context.tasks.propose({ kind: "cancel", taskId: "partial-task-1" });
      await context.tasks.propose({ kind: "cancel", taskId: "partial-task-2" });
      await context.tasks.propose({ kind: "cancel", taskId: "partial-task-3" });
      return "Предложения подготовлены.";
    });
    await tasks.create(owner.employeeId, { id: "partial-task-1", title: "Первое", project: "ASSISTANT", type: "operations", status: "open" });
    await tasks.create(owner.employeeId, { id: "partial-task-2", title: "Второе", project: "ASSISTANT", type: "operations", status: "open" });
    await tasks.create(owner.employeeId, { id: "partial-task-3", title: "Третье", project: "ASSISTANT", type: "operations", status: "open" });

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "отмени три" });
    const proposal = telegram.sentMessages().find((message) => message.text.includes("Предложения:"))!;
    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "только первое" });
    await expect(tasks.get(owner.employeeId, "partial-task-1")).resolves.toMatchObject({ status: "cancelled" });
    await expect(tasks.get(owner.employeeId, "partial-task-2")).resolves.toMatchObject({ status: "open" });
    await expect(tasks.get(owner.employeeId, "partial-task-3")).resolves.toMatchObject({ status: "open" });
    expect(telegram.sentMessages().at(-1)?.text).toContain("Осталось без решения: 2.");
    expect(telegram.sentMessages().at(-1)?.text).toContain("2. Действие: отменить задачу\n   Задача: Второе");
    expect(telegram.sentMessages().at(-1)?.text).toContain("3. Действие: отменить задачу\n   Задача: Третье");

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "второе — да" });
    await expect(tasks.get(owner.employeeId, "partial-task-2")).resolves.toMatchObject({ status: "cancelled" });
    await expect(tasks.get(owner.employeeId, "partial-task-3")).resolves.toMatchObject({ status: "open" });
    expect(telegram.sentMessages().at(-1)?.text).toContain("3. Действие: отменить задачу\n   Задача: Третье");

    await telegram.deliverCallback({ chatId: owner.chatId, userId: owner.userId, callbackData: taskButton(proposal, "✅ Подтвердить всё"), messageId: proposal.messageId, callbackQueryId: "confirm-partial-remainder" });
    await expect(tasks.get(owner.employeeId, "partial-task-3")).resolves.toMatchObject({ status: "cancelled" });
    expect(telegram.taskMutationConfirmCalls()).toEqual(["telegram-confirmation-1", "telegram-confirmation-2", "telegram-confirmation-3"]);
  });

  it("keeps a transiently failed group item retryable under its original ordinal", async () => {
    const { telegram, tasks } = await harness(async (_input, context) => {
      await context.tasks.propose({ kind: "cancel", taskId: "retry-task-1" });
      await context.tasks.propose({ kind: "cancel", taskId: "retry-task-2" });
      await context.tasks.propose({ kind: "cancel", taskId: "retry-task-3" });
      return "Предложения подготовлены.";
    });
    await tasks.create(owner.employeeId, { id: "retry-task-1", title: "Первое", project: "ASSISTANT", type: "operations", status: "open" });
    await tasks.create(owner.employeeId, { id: "retry-task-2", title: "Второе", project: "ASSISTANT", type: "operations", status: "open" });
    await tasks.create(owner.employeeId, { id: "retry-task-3", title: "Третье", project: "ASSISTANT", type: "operations", status: "open" });

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "отмени три" });
    telegram.setTaskMutationConfirmationSequence("fail", "pass");
    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "второе — да" });

    await expect(tasks.get(owner.employeeId, "retry-task-2")).resolves.toMatchObject({ status: "open" });
    expect(telegram.sentMessages().at(-1)?.text).toContain("2. Не удалось обработать действие; его можно повторить.");
    expect(telegram.sentMessages().at(-1)?.text).toContain("2. Действие: отменить задачу\n   Задача: Второе");

    await telegram.sendText({ chatId: owner.chatId, userId: owner.userId, text: "второе — да" });
    await expect(tasks.get(owner.employeeId, "retry-task-2")).resolves.toMatchObject({ status: "cancelled" });
    expect(telegram.taskMutationConfirmCalls()).toEqual(["telegram-confirmation-2", "telegram-confirmation-2"]);
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
