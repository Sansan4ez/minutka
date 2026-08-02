import type { ServiceMinutkaClient } from "../client/sdk/minutka-client.js";
import type { AssistantChatResult } from "../application/assistant-service.js";
import { MinutkaApiError } from "../client/sdk/http-transport.js";
import type { OnboardingProgressResult } from "../client/sdk/minutka-client.js";
import type { TaskMutationDecisionResult } from "../application/task-mutation-confirmation.js";
import { telegramActionMessageClaimLeaseMilliseconds, type TelegramIdentity, type TelegramSessionStore } from "./telegram-session-store.js";
import type { TelegramReplyPort, TelegramSentMessage } from "./telegram-types.js";
import { maxTelegramMessageCharacters, telegramMessageLength } from "./telegram-message-limits.js";
import { renderTelegramMarkdown, renderTelegramPlainText, type TelegramRenderedChunk } from "./telegram-renderer.js";
import { decodeFeedbackCallbackData, decodeIdeaDeletionCallbackData, decodeTaskMutationCallbackData, encodeFeedbackCallbackData, encodeIdeaDeletionCallbackData, encodeTaskMutationCallbackData } from "./callback-data.js";
import { currentPrivacyVersion } from "../domain/privacy.js";
import { PersistenceError } from "../application/persistence-error.js";
import { contextOverflowUserMessage } from "../application/assistant-overflow-recovery.js";
import { mutationOutcomeUserMessage } from "../application/assistant-mutation-outcome.js";
import { voiceProcessingTimeoutMs as defaultVoiceProcessingTimeoutMs, type SpeechToTextPort } from "../application/speech-to-text.js";
import type { TelegramVoiceFileGateway } from "./telegram-voice-file-gateway.js";
import { ArtifactSaveTimeoutError, ArtifactTooLargeError } from "../application/artifact-body-stager.js";
import type { SaveArtifactInput, SaveArtifactResult, TelegramArtifactPayloadKind } from "../application/artifact-store.js";
import type { TelegramFileGateway } from "./telegram-file-gateway.js";
import { randomUUID } from "node:crypto";
import { chatInputFitsCharacterLimit, maxChatInputCharacters } from "../shared/chat-limits.js";
import { pipeline, Transform } from "node:stream";

export { maxTelegramMessageCharacters, telegramMessageLength } from "./telegram-message-limits.js";
const telegramPreferredSplitBoundaries = ["\n\n", "\n", ". ", "! ", "? ", "; ", ", ", " "] as const;

function hardSplitEnd(text: string): number {
  let end = Math.min(maxTelegramMessageCharacters, telegramMessageLength(text));
  if (end < text.length) {
    const lastCodeUnit = text.charCodeAt(end - 1);
    const nextCodeUnit = text.charCodeAt(end);
    if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff && nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff) end -= 1;
  }
  return end;
}

function splitTelegramChunk(text: string): { chunk: string; remainder: string } {
  if (telegramMessageLength(text) <= maxTelegramMessageCharacters) return { chunk: text, remainder: "" };
  const hardEnd = hardSplitEnd(text);
  const prefix = text.slice(0, hardEnd);
  const minimumUsefulBoundary = Math.floor(maxTelegramMessageCharacters * 0.5);
  for (const boundary of telegramPreferredSplitBoundaries) {
    const boundaryIndex = prefix.lastIndexOf(boundary);
    if (boundaryIndex < minimumUsefulBoundary) continue;
    const end = boundaryIndex + boundary.length;
    const chunk = prefix.slice(0, end).trimEnd();
    if (!chunk) continue;
    return { chunk, remainder: text.slice(end).trimStart() };
  }
  return { chunk: prefix, remainder: text.slice(hardEnd) };
}

export function splitTelegramMessage(text: string): string[] {
  const chunks: string[] = [];
  let remainder = text.trim();
  while (remainder) {
    const split = splitTelegramChunk(remainder);
    chunks.push(split.chunk);
    remainder = split.remainder;
  }
  return chunks;
}
const typingRefreshMilliseconds = 4_000;
const maxTelegramCallbackDataBytes = 64;
export const maxVoiceDurationSeconds = 300;
export const maxVoiceFileSizeBytes = 20 * 1024 * 1024;
const inFlightDeliveryMessage = "Пожалуйста, подождите, я ещё отвечаю на предыдущее сообщение.";
const onboardingConfirmationClaimLeaseMilliseconds = 60_000;
const onboardingConfirmationAlreadySentMessage = "Анкета уже готова к подтверждению. Напишите «Да», если всё верно, или «Исправить».";
export const maxTelegramArtifactFileSizeBytes = 100 * 1024 * 1024;
class VoiceFileTooLargeError extends Error {}
class VoiceProcessingTimeoutError extends Error {}
class TaskProposalTerminalizationUnknownError extends Error {}
const taskProposalCancelledMessage = "Не удалось доставить предложение. Оно отменено; создайте новое предложение позже.";
const conversationResetConfirmationMessage = "Готово, начали новый диалог. Предыдущий контекст больше не используется.";
const emptyScheduleMessage = "У вас пока нет расписаний.";
const taskProposalTerminalizationUnknownMessage = "Не удалось доставить предложение и проверить его отмену. Статус предложения неизвестен; попробуйте позже.";
function limitVoiceStream(stream: NodeJS.ReadableStream, maximumBytes: number): NodeJS.ReadableStream {
  let bytes = 0;
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += Buffer.byteLength(chunk);
      callback(bytes > maximumBytes ? new VoiceFileTooLargeError() : undefined, chunk);
    },
  });
  // pipeline forwards source errors and tears down both streams, unlike pipe().
  pipeline(stream, limit, () => undefined);
  return limit;
}
function destroyStream(stream: NodeJS.ReadableStream): void {
  (stream as NodeJS.ReadableStream & { destroy: () => void }).destroy();
}
async function withVoiceTimeout<T>(timeoutMs: number, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      action(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new VoiceProcessingTimeoutError());
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
const onboardingIntroduction = "Давайте коротко познакомимся. Напишите, как к вам обращаться, как вы хотите называть меня, предпочитаете общение на ты или на вы, тёплый или деловой стиль, длину ответов и ваш IANA timezone. Можно ответить одним сообщением или по частям.";
function identity(chatId: string, userId?: string): TelegramIdentity { return { chatId, userId }; }
function logShellError(operation: string, error: unknown): void { console.error(`Telegram shell ${operation} failed (${error instanceof Error ? error.name : "UnknownError"}).`); }
function consentCallbackData(employeeId: string): string | undefined { const callbackData = `tg:consent:${employeeId}`; return Buffer.byteLength(callbackData, "utf8") <= maxTelegramCallbackDataBytes ? callbackData : undefined; }
function onboardingCallbackData(action: "confirm" | "reset" | "addressForm" | "persona" | "responseLength", value?: string): string | undefined {
  const data = value ? `ob:${action}:${value}` : `ob:${action}`;
  return Buffer.byteLength(data, "utf8") <= maxTelegramCallbackDataBytes ? data : undefined;
}
async function sendConsentPrompt(replyPort: TelegramReplyPort, chatId: string, employeeId: string, explanation: string) {
  const callbackData = consentCallbackData(employeeId); if (!callbackData) throw new Error("Telegram consent callback data exceeds the 64-byte limit");
  await replyPort.sendMessage(chatId, explanation, { replyMarkup: { inlineKeyboard: [[{ text: "✅ Принимаю", callbackData }]] } });
}
async function withTypingIndicator<T>(replyPort: TelegramReplyPort, chatId: string, action: () => Promise<T>): Promise<T> {
  const sendTyping = async (): Promise<void> => {
    try { await replyPort.sendChatAction(chatId, "typing"); }
    catch (error) { logShellError("typing indicator", error); }
  };
  await sendTyping();
  const refresh = setInterval(() => { void sendTyping(); }, typingRefreshMilliseconds);
  try { return await action(); } finally { clearInterval(refresh); }
}
function onboardingChoiceValue(field: "addressForm" | "persona" | "responseLength", choice: string): string {
  const values = field === "addressForm"
    ? { "На ты": "informal", "На вы": "formal" }
    : field === "persona"
      ? { "Тёплый": "support", "Деловой": "efficiency" }
      : { "Коротко": "short", "Сбалансированно": "balanced", "Подробно": "detailed" };
  const value = values[choice as keyof typeof values];
  if (!value) throw new Error("unsupported onboarding choice");
  return value;
}
type TelegramChatDeliveryResult = Pick<AssistantChatResult, "messageId" | "response" | "pendingAction">;

function taskPendingAction(chat: TelegramChatDeliveryResult) {
  return "pendingAction" in chat ? chat.pendingAction : undefined;
}
function pendingActionReplyMarkup(chat: TelegramChatDeliveryResult) {
  const pendingAction = taskPendingAction(chat);
  if (!pendingAction) return undefined;
  const encode = pendingAction.actionKind === "delete_idea" ? encodeIdeaDeletionCallbackData : encodeTaskMutationCallbackData;
  return { inlineKeyboard: [[
    { text: "✅ Подтвердить", callbackData: encode("confirm", pendingAction.confirmationId) },
    { text: "❌ Отклонить", callbackData: encode("reject", pendingAction.confirmationId) },
  ]] };
}
function scheduleProcessLabel(processId: string): string {
  return processId === "day_focus" ? "Утренний фокус" : processId === "evening_reflection" ? "Вечерняя рефлексия" : processId;
}
function renderScheduleList(schedules: Awaited<ReturnType<ReturnType<ServiceMinutkaClient["forEmployee"]>["listSchedules"]>>["schedules"]): string {
  if (!schedules.length) return emptyScheduleMessage;
  return ["Ваше расписание:", ...schedules.map((schedule) => [
    `• ${scheduleProcessLabel(schedule.processId)} — ${schedule.timeOfDay} (${schedule.timezone})`,
    `  ${schedule.enabled ? "включено" : "выключено"}; следующее срабатывание: ${schedule.nextFireAt}`,
  ].join("\n"))].join("\n");
}
function previewText(value: { value: string; truncated: boolean }): string {
  return `${value.value}${value.truncated ? "… [сокращено]" : ""}`;
}
function renderTaskActionPreview(preview: NonNullable<ReturnType<typeof taskPendingAction>>["preview"]): string[] {
  if (preview.kind === "delete_idea") return [`Действие: удалить идею`, `Идея: ${previewText(preview.summary)}`, `ID: ${previewText(preview.ideaId)}`];
  if (preview.kind === "create" || preview.kind === "idea_to_task") {
    return [
      `Действие: ${preview.kind === "idea_to_task" ? "создать задачу из идеи" : "создать задачу"}`,
      `Название: ${previewText(preview.title)}`,
      `Проект: ${previewText(preview.project)}`,
      `Тип: ${preview.type}`,
      `Срок: ${preview.dueDate ?? "не указан"}`,
    ];
  }
  switch (preview.kind) {
    case "complete":
    case "cancel":
      return [`Действие: ${preview.kind === "complete" ? "завершить задачу" : "отменить задачу"}`, `Задача: ${previewText(preview.taskId)}`];
    case "update": {
      const labels = { title: "Название", project: "Проект", type: "Тип", status: "Статус", dueDate: "Срок" } as const;
      return [
        "Действие: изменить задачу",
        `Задача: ${previewText(preview.taskId)}`,
        ...preview.fields.map((field) => {
          const value = field.field === "title" || field.field === "project"
            ? previewText(field.value)
            : field.field === "dueDate"
              ? field.value ?? "снять срок"
              : field.value;
          return `${labels[field.field]}: ${value}`;
        }),
      ];
    }
  }
}
export function taskDecisionText(result: TaskMutationDecisionResult): string {
  if (result.status === "confirmed" || result.status === "already_confirmed") {
    if (result.outcome.outcome === "conflict") return "Задача изменилась после предложения. Обновите данные и создайте новое предложение.";
    if (result.outcome.outcome === "not_found") return "Задача не найдена. Изменение не выполнено.";
    return result.status === "already_confirmed" ? "Изменение уже сохранено." : "Изменение сохранено.";
  }
  if (result.status === "rejected") return "Предложение отклонено.";
  if (result.status === "already_rejected") return "Предложение уже отклонено.";
  if (result.status === "expired") return "Срок подтверждения истёк. Изменение не выполнено.";
  if (result.status === "not_found") return "Предложение не найдено. Изменение не выполнено.";
  if (result.status === "owner_mismatch") return "Предложение принадлежит другому владельцу. Изменение не выполнено.";
  if (result.status === "invalid_payload") return "Предложение повреждено или устарело. Изменение не выполнено.";
  return "Не удалось безопасно применить предложение. Изменение не выполнено.";
}
async function sendVoiceTranscript(replyPort: TelegramReplyPort, chatId: string, transcript: string, replyToMessageId: number): Promise<void> {
  // Telegram cannot render a bot-received voice message as a user text message.
  // Reply to its source voice message so the employee can still see the
  // relationship between the original input and text sent to the agent.
  for (const chunk of splitTelegramMessage(`Распознано:\n${transcript}`)) await replyPort.sendMessage(chatId, chunk, { replyToMessageId });
}
async function renderOnboardingProgress(replyPort: TelegramReplyPort, chatId: string, progress: OnboardingProgressResult, confirmationDelivery?: { claim(deliveryKey: string): Promise<{ status: "claimed"; claimedAt: string } | { status: "already_claimed" }>; complete(deliveryKey: string, claimedAt: string): Promise<void>; release(deliveryKey: string, claimedAt: string): Promise<void> }, sendMarkdown?: (chatId: string, markdown: string) => Promise<TelegramSentMessage>): Promise<void> {
  if (progress.status === "needs_answer") { await replyPort.sendMessage(chatId, progress.prompt); return; }
  if (progress.status === "needs_choice") {
    const choices = progress.choices.map((choice) => ({ text: choice, callbackData: onboardingCallbackData(progress.field, onboardingChoiceValue(progress.field, choice)) })).filter((choice): choice is { text: string; callbackData: string } => Boolean(choice.callbackData));
    await replyPort.sendMessage(chatId, progress.prompt, { replyMarkup: { inlineKeyboard: choices.map((choice) => [choice]) } });
    return;
  }
  if (progress.status === "needs_correction") { await replyPort.sendMessage(chatId, progress.prompt); return; }
  if (progress.status === "needs_confirmation") {
    const claim = confirmationDelivery ? await confirmationDelivery.claim(progress.deliveryKey) : undefined;
    if (claim?.status === "already_claimed") {
      await replyPort.sendMessage(chatId, onboardingConfirmationAlreadySentMessage);
      return;
    }
    const summary = progress.summary;
    try {
      await replyPort.sendMessage(chatId, ["Проверьте, пожалуйста:", `- обращаться к вам: ${summary.preferredName};`, `- имя ассистента: ${summary.assistantName};`, `- форма обращения: ${summary.addressForm};`, `- стиль: ${summary.persona};`, `- длина ответов: ${summary.responseLength};`, `- часовой пояс: ${summary.timezone}.`, "", "Всё верно?"].join("\n"), { replyMarkup: { inlineKeyboard: [[{ text: "✅ Подтвердить", callbackData: onboardingCallbackData("confirm")! }, { text: "✏️ Исправить", callbackData: onboardingCallbackData("reset")! }]] } });
      if (confirmationDelivery && claim?.status === "claimed") await confirmationDelivery.complete(progress.deliveryKey, claim.claimedAt);
    } catch (error) {
      if (confirmationDelivery && claim?.status === "claimed") await confirmationDelivery.release(progress.deliveryKey, claim.claimedAt).catch((releaseError) => logShellError("onboarding confirmation claim release", releaseError));
      throw error;
    }
    return;
  }
  const response = progress.result.firstResponse.trim();
  if (!response) throw new Error("Agent returned an empty onboarding response");
  if (sendMarkdown) await sendMarkdown(chatId, response);
  else await deliverTelegramMessage(replyPort, chatId, response);
}

export type TelegramFileAttachment = {
  fileId: string;
  fileUniqueId?: string;
  messageId: number;
  payloadKind: Exclude<TelegramArtifactPayloadKind, "voice" | "sticker">;
  fileName: string;
  declaredMediaType?: string;
  caption?: string;
  mediaGroupId?: string;
  fileSizeBytes?: number;
  forwarded: boolean;
};

export type TelegramArtifactIntake = { saveArtifact(input: SaveArtifactInput): Promise<SaveArtifactResult> };

export async function deliverTelegramMessage(replyPort: TelegramReplyPort, chatId: string, text: string): Promise<void> {
  const chunks = renderTelegramMarkdown(text);
  if (!chunks.length) throw new Error("Telegram delivery text is required");
  for (const chunk of chunks) await replyPort.sendMessage(chatId, chunk.text, { parseMode: chunk.parseMode });
}

export function createTelegramShell(deps: { client: ServiceMinutkaClient; sessionStore: TelegramSessionStore; replyPort: TelegramReplyPort; privacyExplanation: string; artifactIntake?: TelegramArtifactIntake; fileGateway?: TelegramFileGateway; speechToText?: SpeechToTextPort; voiceFileGateway?: TelegramVoiceFileGateway; voiceProcessingTimeoutMs?: number }) {
  const { client, sessionStore, artifactIntake, fileGateway, speechToText, voiceFileGateway } = deps;
  const privacyExplanation = deps.privacyExplanation.trim();
  if (!privacyExplanation) throw new Error("privacyExplanation is required");
  const rawReplyPort = deps.replyPort;
  const voiceTimeoutMs = deps.voiceProcessingTimeoutMs ?? defaultVoiceProcessingTimeoutMs;
  const inFlightChatCounts = new Map<string, number>();
  const activeActionMessageIds = new Map<string, number>();
  const inFlightActionMessages = new Map<string, Promise<boolean>>();
  const callbackActionKeys = new Map<string, string>();
  const employeeClient = (employeeId: string) => client.forEmployee(employeeId);
  const isChatInFlight = (chatId: string) => (inFlightChatCounts.get(chatId) ?? 0) > 0;
  function enterChat(chatId: string): void { inFlightChatCounts.set(chatId, (inFlightChatCounts.get(chatId) ?? 0) + 1); }
  function leaveChat(chatId: string): number {
    const remaining = (inFlightChatCounts.get(chatId) ?? 1) - 1;
    if (remaining <= 0) { inFlightChatCounts.delete(chatId); return 0; }
    inFlightChatCounts.set(chatId, remaining);
    return remaining;
  }
  async function removeReplyMarkup(chatId: string, messageId: number): Promise<void> {
    try {
      await rawReplyPort.editReplyMarkup(chatId, messageId);
      if (activeActionMessageIds.get(chatId) === messageId) activeActionMessageIds.delete(chatId);
    } catch (error) {
      logShellError("reply markup cleanup", error);
    }
  }
  async function removeActiveReplyMarkup(chatId: string): Promise<void> {
    const messageId = activeActionMessageIds.get(chatId);
    if (messageId !== undefined) await removeReplyMarkup(chatId, messageId);
  }
  async function sendRendered(chatId: string, chunks: TelegramRenderedChunk[], options?: Parameters<TelegramReplyPort["sendMessage"]>[2]): Promise<TelegramSentMessage> {
    if (!chunks.length) throw new Error("Telegram delivery text is required");
    if (options?.replyMarkup) await removeActiveReplyMarkup(chatId);
    let sent: TelegramSentMessage | undefined;
    for (const [index, chunk] of chunks.entries()) {
      sent = await rawReplyPort.sendMessage(chatId, chunk.text, {
        parseMode: chunk.parseMode,
        ...(options?.replyToMessageId === undefined || index > 0 ? {} : { replyToMessageId: options.replyToMessageId }),
        ...(options?.replyMarkup === undefined || index < chunks.length - 1 ? {} : { replyMarkup: options.replyMarkup }),
      });
    }
    if (!sent) throw new Error("Telegram delivery text is required");
    if (options?.replyMarkup) activeActionMessageIds.set(chatId, sent.messageId);
    return sent;
  }
  const replyPort: TelegramReplyPort = {
    sendMessage: (chatId, text, options) => sendRendered(chatId, renderTelegramPlainText(text), options),
    editReplyMarkup: (chatId, messageId, replyMarkup) => rawReplyPort.editReplyMarkup(chatId, messageId, replyMarkup),
    sendChatAction: (chatId, action) => rawReplyPort.sendChatAction(chatId, action),
    answerCallbackQuery: (callbackQueryId, text) => rawReplyPort.answerCallbackQuery(callbackQueryId, text),
  };
  const sendMarkdown = (chatId: string, markdown: string, options?: Parameters<TelegramReplyPort["sendMessage"]>[2]) => sendRendered(chatId, renderTelegramMarkdown(markdown), options);
  async function runCallbackAction<T>(input: { chatId: string; userId?: string; employeeId: string; messageId?: number; callbackQueryId: string; action: () => Promise<T>; repeatedText?: string }): Promise<{ repeated: true } | { repeated: false; result: T }> {
    const { chatId, userId, employeeId, messageId, callbackQueryId, action, repeatedText = "Уже обработано." } = input;
    if (messageId === undefined) return { repeated: false, result: await action() };
    const key = `${chatId}:${messageId}`;
    const inFlight = inFlightActionMessages.get(key);
    if (inFlight && await inFlight) {
      await replyPort.answerCallbackQuery(callbackQueryId, repeatedText);
      await removeReplyMarkup(chatId, messageId);
      return { repeated: true };
    }
    let settleCompletion!: (completed: boolean) => void;
    const completion = new Promise<boolean>((resolve) => { settleCompletion = resolve; });
    inFlightActionMessages.set(key, completion);
    const claimedAt = new Date().toISOString();
    const staleBefore = new Date(Date.parse(claimedAt) - telegramActionMessageClaimLeaseMilliseconds).toISOString();
    const telegramIdentity = identity(chatId, userId);
    let claimAcquired = false;
    let completed = false;
    try {
      const claim = await sessionStore.claimActionMessage({ identity: telegramIdentity, employeeId, messageId, claimedAt, staleBefore });
      if (claim.status === "already_claimed") {
        await replyPort.answerCallbackQuery(callbackQueryId, repeatedText);
        await removeReplyMarkup(chatId, messageId);
        completed = true;
        return { repeated: true };
      }
      claimAcquired = true;
      const result = await action();
      await sessionStore.completeActionMessage({ identity: telegramIdentity, employeeId, messageId, claimedAt });
      completed = true;
      return { repeated: false, result };
    } catch (error) {
      if (claimAcquired) await sessionStore.releaseActionMessage({ identity: telegramIdentity, employeeId, messageId, claimedAt }).catch((releaseError) => logShellError("action message claim release", releaseError));
      throw error;
    } finally {
      settleCompletion(completed);
      if (inFlightActionMessages.get(key) === completion) inFlightActionMessages.delete(key);
    }
  }
  async function getLinkedSession(chatId: string, userId?: string) {
    const telegramIdentity = identity(chatId, userId);
    const session = await sessionStore.getByIdentity(telegramIdentity);
    if (session && !session.deliveryTargetLinked) {
      await sessionStore.linkDeliveryTarget({ identity: telegramIdentity, employeeId: session.employeeId });
      return { ...session, deliveryTargetLinked: true };
    }
    return session;
  }
  async function authorizedSession(chatId: string, userId?: string) {
    const session = await getLinkedSession(chatId, userId);
    if (!session) {
      const existingChat = await sessionStore.getByIdentity(identity(chatId));
      await replyPort.sendMessage(chatId, existingChat ? "Этот аккаунт не связан с данным чатом." : "Откройте бота по индивидуальной ссылке /start <code>");
      return undefined;
    }
    if (!session.consentAcceptedAt || session.consentPrivacyVersion !== currentPrivacyVersion) {
      await replyPort.sendMessage(chatId, "Сначала подтвердите согласие с политикой конфиденциальности.");
      return undefined;
    }
    return session;
  }
  function onboardingConfirmationDelivery(chatId: string, userId: string | undefined, employeeId: string) {
    const telegramIdentity = identity(chatId, userId);
    return {
      async claim(deliveryKey: string) {
        const claimedAt = new Date().toISOString();
        const staleBefore = new Date(Date.parse(claimedAt) - onboardingConfirmationClaimLeaseMilliseconds).toISOString();
        const result = await sessionStore.claimOnboardingConfirmationDelivery({ identity: telegramIdentity, employeeId, deliveryKey, claimedAt, staleBefore });
        return result.status === "claimed" ? { status: "claimed" as const, claimedAt } : result;
      },
      async complete(deliveryKey: string, claimedAt: string) { await sessionStore.completeOnboardingConfirmationDelivery({ identity: telegramIdentity, employeeId, deliveryKey, claimedAt }); },
      async release(deliveryKey: string, claimedAt: string) { await sessionStore.releaseOnboardingConfirmationDelivery({ identity: telegramIdentity, employeeId, deliveryKey, claimedAt }); },
    };
  }
  async function sendTaskProposal(chatId: string, chat: TelegramChatDeliveryResult, employeeId: string): Promise<"delivered" | "cancelled"> {
    const pendingAction = taskPendingAction(chat);
    if (!pendingAction) return "delivered";
    const text = ["Предложение:", ...renderTaskActionPreview(pendingAction.preview), "", "Подтвердить изменение?"].join("\n");
    const options = { replyMarkup: pendingActionReplyMarkup(chat) };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const rendered = renderTelegramPlainText(text);
        if (rendered.length !== 1) throw new Error("Telegram task proposal exceeds one message");
        await rawReplyPort.sendMessage(chatId, rendered[0]!.text, { ...options, parseMode: rendered[0]!.parseMode });
        return "delivered";
      } catch (error) {
        logShellError("task proposal delivery", error);
      }
    }
    let rejected: { status: string };
    try {
      rejected = pendingAction.actionKind === "delete_idea"
        ? await employeeClient(employeeId).rejectIdeaDeletion(pendingAction.confirmationId)
        : await employeeClient(employeeId).rejectTaskMutation(pendingAction.confirmationId);
    } catch (error) {
      logShellError("task proposal terminal rejection", error);
      throw new TaskProposalTerminalizationUnknownError();
    }
    if (rejected.status === "rejected" || rejected.status === "already_rejected" || rejected.status === "not_found") return "cancelled";
    logShellError("task proposal terminal rejection", new TaskProposalTerminalizationUnknownError());
    throw new TaskProposalTerminalizationUnknownError();
  }
  async function deliverChatResult(chatId: string, chat: TelegramChatDeliveryResult, employeeId: string): Promise<void> {
    if (!chat.response.trim()) throw new Error("Agent returned an empty response");
    const pendingAction = taskPendingAction(chat);
    const feedbackMarkup = { inlineKeyboard: [["positive", "neutral", "negative"].map((rating) => ({ text: rating === "positive" ? "👍" : rating === "neutral" ? "👌" : "👎", callbackData: encodeFeedbackCallbackData(rating as "positive" | "neutral" | "negative", chat.messageId) }))] };
    if (pendingAction) {
      await removeActiveReplyMarkup(chatId);
      if (await sendTaskProposal(chatId, chat, employeeId) === "cancelled") {
        await replyPort.sendMessage(chatId, taskProposalCancelledMessage);
        return;
      }
    }
    await sendMarkdown(chatId, chat.response, !pendingAction ? { replyMarkup: feedbackMarkup } : undefined);
  }
  async function dispatchText(chatId: string, text: string, session: { employeeId: string; threadId: string }, inputModality: "text" | "voice", userId?: string) {
    let profileExists = true;
    try { await employeeClient(session.employeeId).getProfile(); } catch (error) { if ((error instanceof PersistenceError || error instanceof MinutkaApiError) && error.code === "profile_not_found") profileExists = false; else throw error; }
    if (!profileExists) return renderOnboardingProgress(replyPort, chatId, await employeeClient(session.employeeId).submitOnboardingAnswer({ text }), onboardingConfirmationDelivery(chatId, userId, session.employeeId), sendMarkdown);
    const chat = await employeeClient(session.employeeId).chat({ threadId: session.threadId, text, inputModality, responseChannel: "telegram" });
    await deliverChatResult(chatId, chat, session.employeeId);
  }
  return {
    async deliverProactive(chatId: string, result: AssistantChatResult, employeeId: string) {
      await deliverChatResult(chatId, result, employeeId);
    },
    async handleStart(chatId: string, inviteCode?: string, userId?: string) {
      await removeActiveReplyMarkup(chatId);
      try {
        if (!userId) return void await replyPort.sendMessage(chatId, "Не удалось определить аккаунт Telegram.");
        const telegramIdentity = identity(chatId, userId); const existing = await getLinkedSession(chatId, userId);
        if (existing) {
          if (!existing.consentAcceptedAt || existing.consentPrivacyVersion !== currentPrivacyVersion) { await sendConsentPrompt(replyPort, chatId, existing.employeeId, privacyExplanation); await employeeClient(existing.employeeId).recordPrivacyExplanationShown(); return; }
          return void await replyPort.sendMessage(chatId, "Вы уже зарегистрированы. Вы можете общаться с ботом.");
        }
        const existingChat = await sessionStore.getByIdentity(identity(chatId));
        if (existingChat) return void await replyPort.sendMessage(chatId, "Этот аккаунт не связан с данным чатом.");
        if (!inviteCode) return void await replyPort.sendMessage(chatId, "Добро пожаловать! Для начала работы вам нужна индивидуальная ссылка с инвайт-кодом.");
        const redeemed = await client.redeemTelegramInvite({ inviteCode, identity: telegramIdentity });
        await sendConsentPrompt(replyPort, chatId, redeemed.employeeId, redeemed.privacyExplanation); await employeeClient(redeemed.employeeId).recordPrivacyExplanationShown();
      } catch (error) {
        logShellError("/start", error); const code = error instanceof PersistenceError || error instanceof MinutkaApiError ? error.code : undefined;
        const message = code === "employee_already_linked" ? "Эта индивидуальная ссылка уже привязана к другому Telegram-аккаунту." : code === "chat_already_linked" ? "Этот чат уже связан с профилем." : code === "invite_not_found" ? "Эта индивидуальная ссылка недействительна. Обратитесь за новой ссылкой." : "Не удалось завершить настройку. Попробуйте ещё раз позже.";
        await replyPort.sendMessage(chatId, message);
      }
    },
    async handleSchedule(chatId: string, userId?: string) {
      if (isChatInFlight(chatId)) return void await replyPort.sendMessage(chatId, inFlightDeliveryMessage); enterChat(chatId);
      try {
        await removeActiveReplyMarkup(chatId);
        const session = await authorizedSession(chatId, userId); if (!session) return;
        const result = await employeeClient(session.employeeId).listSchedules();
        await replyPort.sendMessage(chatId, renderScheduleList(result.schedules));
      } catch (error) {
        logShellError("/schedule", error);
        await replyPort.sendMessage(chatId, "Не удалось показать расписание. Попробуйте ещё раз позже.");
      } finally { leaveChat(chatId); }
    },
    async handleNew(chatId: string, userId?: string) {
      if (isChatInFlight(chatId)) return void await replyPort.sendMessage(chatId, inFlightDeliveryMessage); enterChat(chatId);
      try {
        await removeActiveReplyMarkup(chatId);
        const session = await authorizedSession(chatId, userId); if (!session) return;
        await employeeClient(session.employeeId).resetConversation();
        await replyPort.sendMessage(chatId, conversationResetConfirmationMessage);
      } catch (error) {
        logShellError("/new", error);
        await replyPort.sendMessage(chatId, "Не удалось начать новый диалог. Попробуйте ещё раз позже.");
      } finally { leaveChat(chatId); }
    },
    async handleText(chatId: string, text: string, userId?: string) {
      if (isChatInFlight(chatId)) return void await replyPort.sendMessage(chatId, inFlightDeliveryMessage); enterChat(chatId);
      try {
        await removeActiveReplyMarkup(chatId);
        const trimmed = text.trim(); if (!trimmed) return void await replyPort.sendMessage(chatId, "Сообщение не может быть пустым."); if (!chatInputFitsCharacterLimit(trimmed)) return void await replyPort.sendMessage(chatId, `Сообщение слишком длинное (максимум ${maxChatInputCharacters} символов).`);
        const session = await authorizedSession(chatId, userId); if (!session) return;
        await withTypingIndicator(replyPort, chatId, () => dispatchText(chatId, trimmed, session, "text", userId));
      } catch (error) { logShellError("text message", error); await replyPort.sendMessage(chatId, error instanceof TaskProposalTerminalizationUnknownError ? taskProposalTerminalizationUnknownMessage : mutationOutcomeUserMessage(error) ?? contextOverflowUserMessage(error) ?? "Не удалось обработать сообщение. Попробуйте ещё раз позже."); } finally { leaveChat(chatId); }
    },
    async handleFile(chatId: string, attachment: TelegramFileAttachment, userId?: string) {
      if (isChatInFlight(chatId)) return void await replyPort.sendMessage(chatId, inFlightDeliveryMessage); enterChat(chatId);
      try {
        await removeActiveReplyMarkup(chatId);
        const session = await authorizedSession(chatId, userId); if (!session) return;
        if (!artifactIntake || !fileGateway) return void await replyPort.sendMessage(chatId, "Сохранение файлов сейчас недоступно. Попробуйте ещё раз позже.");
        if (attachment.fileSizeBytes !== undefined && attachment.fileSizeBytes > maxTelegramArtifactFileSizeBytes) return void await replyPort.sendMessage(chatId, "Файл слишком большой (максимум 100 МБ).");
        const deliveryKey = `telegram:${chatId}:${attachment.messageId}:${attachment.payloadKind}:${attachment.fileUniqueId ?? attachment.fileId}`;
        await artifactIntake.saveArtifact({
          ownerId: session.employeeId,
          artifactId: `artifact_${randomUUID()}`,
          originalFileName: attachment.fileName,
          ...(attachment.declaredMediaType === undefined ? {} : { declaredMediaType: attachment.declaredMediaType }),
          source: {
            kind: "telegram",
            deliveryKey,
            chatId,
            messageId: attachment.messageId,
            payloadKind: attachment.payloadKind,
            forwarded: attachment.forwarded,
            fileId: attachment.fileId,
            ...(attachment.fileUniqueId === undefined ? {} : { fileUniqueId: attachment.fileUniqueId }),
            ...(attachment.mediaGroupId === undefined ? {} : { mediaGroupId: attachment.mediaGroupId }),
          },
          ...(attachment.caption?.trim() ? { caption: attachment.caption.trim() } : {}),
          body: fileGateway.createFileBody({ fileId: attachment.fileId, fileSizeBytes: attachment.fileSizeBytes }),
        });
        await replyPort.sendMessage(chatId, "Файл сохранён.");
      } catch (error) {
        logShellError("file message", error);
        const message = error instanceof ArtifactTooLargeError ? "Файл слишком большой (максимум 100 МБ)."
          : error instanceof ArtifactSaveTimeoutError || (error instanceof Error && error.name === "AbortError") ? "Не удалось сохранить файл вовремя. Попробуйте ещё раз позже."
          : "Не удалось сохранить файл. Попробуйте ещё раз позже.";
        await replyPort.sendMessage(chatId, message);
      } finally { leaveChat(chatId); }
    },
    async handleUnsupportedAttachment(chatId: string, userId?: string) {
      await removeActiveReplyMarkup(chatId);
      try { if (await authorizedSession(chatId, userId)) await replyPort.sendMessage(chatId, "Этот тип вложения пока не поддерживается."); }
      catch (error) { logShellError("unsupported attachment", error); await replyPort.sendMessage(chatId, "Не удалось обработать вложение. Попробуйте ещё раз позже."); }
    },
    async handleVoice(chatId: string, voice: { fileId: string; messageId: number; durationSeconds: number; fileSizeBytes?: number }, userId?: string) {
      if (isChatInFlight(chatId)) return void await replyPort.sendMessage(chatId, inFlightDeliveryMessage); enterChat(chatId);
      try {
        await removeActiveReplyMarkup(chatId);
        const session = await authorizedSession(chatId, userId); if (!session) return;
        if (!speechToText || !voiceFileGateway) return void await replyPort.sendMessage(chatId, "Голосовые сообщения сейчас недоступны. Пожалуйста, напишите текстом.");
        if (voice.durationSeconds > maxVoiceDurationSeconds) return void await replyPort.sendMessage(chatId, "Голосовое сообщение слишком длинное (максимум 5 минут).");
        if (voice.fileSizeBytes !== undefined && voice.fileSizeBytes > maxVoiceFileSizeBytes) return void await replyPort.sendMessage(chatId, "Голосовое сообщение слишком большое (максимум 20 МБ).");
        let file: Awaited<ReturnType<TelegramVoiceFileGateway["openVoiceFile"]>> | undefined;
        let audio: NodeJS.ReadableStream | undefined;
        try {
          // Download and STT share one budget. A single deadline prevents a
          // stalled download followed by a stalled provider call from holding
          // the per-chat guard for twice the configured processing window.
          await withTypingIndicator(replyPort, chatId, async () => {
            const transcript = (await withVoiceTimeout(voiceTimeoutMs, async (signal) => {
              file = await voiceFileGateway.openVoiceFile(voice.fileId, signal);
              audio = voice.fileSizeBytes === undefined ? limitVoiceStream(file.stream, maxVoiceFileSizeBytes) : file.stream;
              signal.addEventListener("abort", () => {
                if (audio) destroyStream(audio);
                if (audio && audio !== file?.stream) destroyStream(file!.stream);
              }, { once: true });
              return speechToText.transcribe({ audio, filetype: file.filetype, signal });
            })).trim();
            if (!transcript) return void await replyPort.sendMessage(chatId, "Не удалось распознать голосовое сообщение. Попробуйте ещё раз или напишите текстом.");
            if (!chatInputFitsCharacterLimit(transcript)) return void await replyPort.sendMessage(chatId, `Сообщение слишком длинное (максимум ${maxChatInputCharacters} символов).`);
            await sendVoiceTranscript(replyPort, chatId, transcript, voice.messageId);
            await dispatchText(chatId, transcript, session, "voice", userId);
          });
        } finally {
          // A provider can fail before consuming the download; close it promptly.
          if (audio) destroyStream(audio);
          if (audio && audio !== file?.stream) destroyStream(file!.stream);
        }
      } catch (error) { logShellError("voice message", error); await replyPort.sendMessage(chatId, error instanceof VoiceFileTooLargeError ? "Голосовое сообщение слишком большое (максимум 20 МБ)." : error instanceof TaskProposalTerminalizationUnknownError ? taskProposalTerminalizationUnknownMessage : mutationOutcomeUserMessage(error) ?? contextOverflowUserMessage(error) ?? "Не удалось обработать голосовое сообщение. Попробуйте ещё раз позже."); } finally { leaveChat(chatId); }
    },
    async handleCallback(chatId: string, callbackQueryId: string, data: string, userId?: string, messageId?: number) {
      const actionKey = messageId === undefined ? undefined : `${chatId}:${messageId}`;
      const existingActionKey = callbackActionKeys.get(chatId);
      if (isChatInFlight(chatId) && (!actionKey || existingActionKey !== actionKey)) return void await replyPort.answerCallbackQuery(callbackQueryId, inFlightDeliveryMessage);
      enterChat(chatId);
      if (actionKey) callbackActionKeys.set(chatId, actionKey);
      try {
        const telegramIdentity = identity(chatId, userId); const session = await getLinkedSession(chatId, userId);
        if (data.startsWith("tg:consent:")) {
          const employeeId = data.slice("tg:consent:".length); if (!session || session.employeeId !== employeeId) return void await replyPort.answerCallbackQuery(callbackQueryId, "Неверная сессия.");
          const handled = await runCallbackAction({ chatId, userId, employeeId, messageId, callbackQueryId, action: () => employeeClient(employeeId).acceptConsent({ accepted: true, source: "telegram", telegramIdentity }) });
          if (handled.repeated) return;
          await replyPort.answerCallbackQuery(callbackQueryId, "Согласие принято!");
          if (messageId !== undefined) await removeReplyMarkup(chatId, messageId);
          try { await replyPort.sendMessage(chatId, onboardingIntroduction); } catch (error) { logShellError("consent follow-up delivery", error); }
          return;
        }
        if (data.startsWith("ob:")) {
          if (!session) return void await replyPort.answerCallbackQuery(callbackQueryId, "Сессия не найдена. Выполните /start.");
          if (!session.consentAcceptedAt || session.consentPrivacyVersion !== currentPrivacyVersion) return void await replyPort.answerCallbackQuery(callbackQueryId, "Сначала подтвердите согласие с политикой конфиденциальности.");
          const [prefix, action, value, ...extra] = data.split(":");
          if (prefix !== "ob" || extra.length || !action) return void await replyPort.answerCallbackQuery(callbackQueryId, "Неизвестное действие.");
          if (action === "confirm" && !value) {
            const handled = await runCallbackAction({ chatId, userId, employeeId: session.employeeId, messageId, callbackQueryId, action: () => withTypingIndicator(replyPort, chatId, () => employeeClient(session.employeeId).confirmOnboarding()), repeatedText: "Профиль уже сохранён." });
            if (handled.repeated) return;
            const alreadySaved = handled.result.completion === "already";
            await replyPort.answerCallbackQuery(callbackQueryId, alreadySaved ? "Профиль уже сохранён." : "Профиль сохранён!");
            if (messageId !== undefined) await removeReplyMarkup(chatId, messageId);
            if (alreadySaved) return;
            await sendMarkdown(chatId, handled.result.firstResponse);
            return;
          }
          if (action === "reset" && !value) {
            const handled = await runCallbackAction({ chatId, userId, employeeId: session.employeeId, messageId, callbackQueryId, action: () => employeeClient(session.employeeId).submitOnboardingAnswer({ text: "Исправить" }) });
            if (handled.repeated) return;
            await replyPort.answerCallbackQuery(callbackQueryId, "Что нужно исправить?");
            if (messageId !== undefined) await removeReplyMarkup(chatId, messageId);
            return renderOnboardingProgress(replyPort, chatId, handled.result, onboardingConfirmationDelivery(chatId, userId, session.employeeId), sendMarkdown);
          }
          if ((action === "addressForm" || action === "persona" || action === "responseLength") && value) {
            const handled = await runCallbackAction({ chatId, userId, employeeId: session.employeeId, messageId, callbackQueryId, action: () => employeeClient(session.employeeId).submitOnboardingAnswer({ text: value }) });
            if (handled.repeated) return;
            await replyPort.answerCallbackQuery(callbackQueryId);
            if (messageId !== undefined) await removeReplyMarkup(chatId, messageId);
            return renderOnboardingProgress(replyPort, chatId, handled.result, onboardingConfirmationDelivery(chatId, userId, session.employeeId), sendMarkdown);
          }
          return void await replyPort.answerCallbackQuery(callbackQueryId, "Неизвестное действие.");
        }
        if (data.startsWith("tm:") || data.startsWith("id:")) {
          const ideaDeletion = data.startsWith("id:");
          const decoded = ideaDeletion ? decodeIdeaDeletionCallbackData(data) : decodeTaskMutationCallbackData(data);
          if (!decoded) return void await replyPort.answerCallbackQuery(callbackQueryId, "Неверный формат действия.");
          if (!session) { const existingChat = await sessionStore.getByIdentity(identity(chatId)); return void await replyPort.answerCallbackQuery(callbackQueryId, existingChat ? "Этот аккаунт не связан с данным чатом." : "Сессия не найдена. Выполните /start."); }
          if (!session.consentAcceptedAt || session.consentPrivacyVersion !== currentPrivacyVersion) return void await replyPort.answerCallbackQuery(callbackQueryId, "Сначала подтвердите согласие с политикой конфиденциальности.");
          const action = ideaDeletion
            ? () => decoded.action === "confirm"
              ? employeeClient(session.employeeId).confirmIdeaDeletion(decoded.confirmationId)
              : employeeClient(session.employeeId).rejectIdeaDeletion(decoded.confirmationId)
            : () => decoded.action === "confirm"
              ? employeeClient(session.employeeId).confirmTaskMutation(decoded.confirmationId)
              : employeeClient(session.employeeId).rejectTaskMutation(decoded.confirmationId);
          const handled = await runCallbackAction({
            chatId, userId, employeeId: session.employeeId, messageId, callbackQueryId,
            action: action as () => Promise<{ status: string }>,
            repeatedText: "Уже обработано.",
          });
          if (handled.repeated) return;
          const text = ideaDeletion
            ? handled.result.status === "confirmed" ? "Идея удалена. Можно отменить удаление командой «верни последнюю идею»."
              : handled.result.status === "already_confirmed" ? "Идея уже удалена."
                : handled.result.status === "rejected" || handled.result.status === "already_rejected" ? "Удаление отменено."
                  : handled.result.status === "expired" ? "Время подтверждения истекло." : "Идея не найдена."
            : taskDecisionText(handled.result as TaskMutationDecisionResult);
          try { await replyPort.answerCallbackQuery(callbackQueryId, text); }
          catch (error) { logShellError("task decision callback answer", error); }
          if (messageId !== undefined) await removeReplyMarkup(chatId, messageId);
          return;
        }
        if (!data.startsWith("fb:")) return void await replyPort.answerCallbackQuery(callbackQueryId, "Неизвестное действие."); const decoded = decodeFeedbackCallbackData(data); if (!decoded) return void await replyPort.answerCallbackQuery(callbackQueryId, "Неверный формат отзыва.");
        if (!session) { const existingChat = await sessionStore.getByIdentity(identity(chatId)); return void await replyPort.answerCallbackQuery(callbackQueryId, existingChat ? "Этот аккаунт не связан с данным чатом." : "Сессия не найдена. Выполните /start."); }
        if (!session.consentAcceptedAt || session.consentPrivacyVersion !== currentPrivacyVersion) return void await replyPort.answerCallbackQuery(callbackQueryId, "Сначала подтвердите согласие с политикой конфиденциальности.");
        const handled = await runCallbackAction({ chatId, userId, employeeId: session.employeeId, messageId, callbackQueryId, action: () => employeeClient(session.employeeId).submitFeedback({ threadId: session.threadId, targetMessageId: decoded.targetMessageId, rating: decoded.rating, source: "telegram" }) });
        if (handled.repeated) return;
        await replyPort.answerCallbackQuery(callbackQueryId, "Спасибо, учту 👍");
        if (messageId !== undefined) await removeReplyMarkup(chatId, messageId);
      } catch (error) {
        logShellError("callback", error); await replyPort.answerCallbackQuery(callbackQueryId, data.startsWith("tg:consent:") ? "Не удалось сохранить согласие. Попробуйте ещё раз позже." : data.startsWith("ob:") ? "Не удалось сохранить профиль. Попробуйте ещё раз позже." : data.startsWith("tm:") || data.startsWith("id:") ? "Не удалось обработать предложение. Попробуйте ещё раз позже." : "Не удалось сохранить отзыв. Попробуйте ещё раз позже.");
      } finally {
        const remaining = leaveChat(chatId);
        if (remaining === 0 && actionKey && callbackActionKeys.get(chatId) === actionKey) callbackActionKeys.delete(chatId);
      }
    },
  };
}
