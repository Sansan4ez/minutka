import type { ServiceMinutkaClient } from "../client/sdk/minutka-client.js";
import type { AssistantChatResult, AssistantPendingAction } from "../application/assistant-service.js";
import type { IdeaDeletionDecisionResult } from "../application/idea-deletion.js";
import { MinutkaApiError } from "../client/sdk/http-transport.js";
import type { OnboardingProgressResult } from "../client/sdk/minutka-client.js";
import type { TaskMutationDecisionResult } from "../application/task-mutation-confirmation.js";
import type { ContextDocumentDecisionResult } from "../application/context-document-service.js";
import { telegramActionMessageClaimLeaseMilliseconds, type TelegramIdentity, type TelegramSessionStore } from "./telegram-session-store.js";
import type { TelegramReplyPort, TelegramSentMessage } from "./telegram-types.js";
import { maxTelegramMessageCharacters, telegramMessageLength } from "./telegram-message-limits.js";
import { renderTelegramMarkdown, renderTelegramPlainText, type TelegramRenderedChunk } from "./telegram-renderer.js";
import { decodeContextDocumentMutationCallbackData, decodeFeedbackCallbackData, decodeIdeaDeletionCallbackData, decodePendingActionGroupCallbackData, decodeTaskMutationCallbackData, encodeContextDocumentMutationCallbackData, encodeFeedbackCallbackData, encodeIdeaDeletionCallbackData, encodePendingActionGroupCallbackData, encodeTaskMutationCallbackData } from "./callback-data.js";
import { currentPrivacyVersion } from "../domain/privacy.js";
import { PersistenceError } from "../application/persistence-error.js";
import { contextOverflowUserMessage } from "../application/assistant-overflow-recovery.js";
import { mutationOutcomeUserMessage } from "../application/assistant-mutation-outcome.js";
import { voiceProcessingTimeoutMs as defaultVoiceProcessingTimeoutMs, type SpeechToTextPort } from "../application/speech-to-text.js";
import type { TelegramVoiceFileGateway } from "./telegram-voice-file-gateway.js";
import { ArtifactSaveTimeoutError, ArtifactTooLargeError } from "../application/artifact-body-stager.js";
import { ArtifactGlobalCapacityExceededError, ArtifactOwnerQuotaExceededError } from "../application/artifact-capacity.js";
import type { SaveArtifactInput, SaveArtifactResult, TelegramArtifactPayloadKind } from "../application/artifact-store.js";
import type { TelegramFileGateway } from "./telegram-file-gateway.js";
import { randomUUID } from "node:crypto";
import { chatInputFitsCharacterLimit, maxChatInputCharacters } from "../shared/chat-limits.js";
import type { PendingActionGroup, PendingActionGroupItem, PendingActionGroupOrdinal, PendingActionGroupStore } from "./pending-action-group-store.js";
import { createInMemoryPendingActionGroupStore } from "./in-memory-pending-action-group-store.js";
import { pipeline, Transform } from "node:stream";
import { classifyTextConfirmation, classifyTextConfirmationSelection, type TextConfirmationDecision, type TextConfirmationSelection } from "./text-confirmation.js";

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
function artifactObjectLimitMessage(maximumBytes: number): string {
  const mebibytes = maximumBytes / (1024 * 1024);
  const label = Number.isInteger(mebibytes) ? String(mebibytes) : mebibytes.toFixed(1);
  return `Файл слишком большой (максимум ${label} МБ).`;
}
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
const onboardingIntroduction = "Давайте коротко познакомимся.";
function identity(chatId: string, userId?: string): TelegramIdentity { return { chatId, userId }; }
function logShellError(operation: string, error: unknown): void { console.error(`Telegram shell ${operation} failed (${error instanceof Error ? error.name : "UnknownError"}).`); }
function logArtifactRejection(reason: "object_limit" | "owner_quota" | "global_capacity"): void {
  console.warn(`Artifact save rejected (${reason}).`);
}
function consentCallbackData(employeeId: string): string | undefined { const callbackData = `tg:consent:${employeeId}`; return Buffer.byteLength(callbackData, "utf8") <= maxTelegramCallbackDataBytes ? callbackData : undefined; }
function onboardingCallbackData(action: "confirm" | "reset" | "roleId" | "addressForm" | "persona" | "responseLength" | "timezone", value?: string): string | undefined {
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
function onboardingChoiceValue(field: "addressForm" | "persona" | "responseLength" | "timezone", choice: string): string {
  const values: Record<string, string> = field === "addressForm"
    ? { "На ты": "informal", "На вы": "formal" }
    : field === "persona"
      ? { "Тёплый": "support", "Деловой": "efficiency" }
      : field === "responseLength"
        ? { "Коротко": "short", "Сбалансированно": "balanced", "Подробно": "detailed" }
        : {
          "Калининград": "Europe/Kaliningrad", "Москва": "Europe/Moscow", "Самара": "Europe/Samara",
          "Екатеринбург": "Asia/Yekaterinburg", "Омск": "Asia/Omsk", "Красноярск": "Asia/Krasnoyarsk",
          "Иркутск": "Asia/Irkutsk", "Владивосток": "Asia/Vladivostok", "Другой": "other",
        };
  const value = values[choice];
  if (!value) throw new Error("unsupported onboarding choice");
  return value;
}
function currentTimeInTimezone(timezone: string): string {
  return new Intl.DateTimeFormat("ru-RU", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
}
type TelegramChatDeliveryResult = { messageId?: string; response: string; pendingActions: AssistantPendingAction[] };
type ActivePendingAction = { action: AssistantPendingAction; messageId: number };
type ActivePendingActionGroup = PendingActionGroup & { state: "delivered"; messageId: number };
type GroupDecisionOutcome = { ordinal: PendingActionGroupOrdinal; state: "resolved" | "retryable"; line: string };

function pendingActionReplyMarkup(action: AssistantPendingAction) {
  const encode = action.actionKind === "delete_idea"
    ? encodeIdeaDeletionCallbackData
    : action.actionKind === "update" || action.actionKind === "move" || action.actionKind === "delete"
      ? encodeContextDocumentMutationCallbackData
      : encodeTaskMutationCallbackData;
  return { inlineKeyboard: [[
    { text: "✅ Подтвердить", callbackData: encode("confirm", action.confirmationId) },
    { text: "❌ Отклонить", callbackData: encode("reject", action.confirmationId) },
  ]] };
}
function pendingActionGroupReplyMarkup(groupId: string) {
  return { inlineKeyboard: [[
    { text: "✅ Подтвердить всё", callbackData: encodePendingActionGroupCallbackData("confirm", groupId) },
    { text: "❌ Отклонить всё", callbackData: encodePendingActionGroupCallbackData("reject", groupId) },
  ]] };
}
function isLevelOnePendingAction(action: ActivePendingAction["action"]): boolean {
  return action.actionKind === "cancel" || action.actionKind === "delete_idea" || action.actionKind === "move" || action.actionKind === "delete";
}
function scheduleProcessLabel(processId: string): string {
  return processId === "morning_activity_collection"
    ? "Утренняя Минутка"
    : processId === "day_focus"
      ? "Фокус дня"
      : processId === "evening_reflection"
        ? "Вечерняя рефлексия"
        : processId;
}
function scheduleDaysLabel(daysOfWeek: number): string {
  if (daysOfWeek === 127) return "каждый день";
  if (daysOfWeek === 31) return "по будням";
  if (daysOfWeek === 96) return "по выходным";
  const labels = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
  return labels.filter((_, index) => (daysOfWeek & (1 << index)) !== 0).join(", ");
}
function formatScheduleNextFireAt(nextFireAt: string, timezone: string): string {
  const parts = new Map(new Intl.DateTimeFormat("ru-RU", {
    timeZone: timezone,
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(nextFireAt)).map(({ type, value }) => [type, value]));
  return `${parts.get("day")}.${parts.get("month")} ${parts.get("hour")}:${parts.get("minute")} (${timezone})`;
}
function renderScheduleList(schedules: Awaited<ReturnType<ReturnType<ServiceMinutkaClient["forEmployee"]>["listSchedules"]>>["schedules"]): string {
  if (!schedules.length) return emptyScheduleMessage;
  return ["Ваше расписание:", ...schedules.map((schedule) => {
    const label = schedule.kind === "reminder" ? `Напоминание: ${schedule.reminderText}` : scheduleProcessLabel(schedule.processId!);
    const cadence = `${scheduleDaysLabel(schedule.daysOfWeek)}${schedule.oneShot ? "; разовое" : ""}`;
    return [
      `• ${label} — ${schedule.timeOfDay} (${schedule.timezone}); ${cadence}`,
      `  ${schedule.enabled ? "включено" : "выключено"}; следующее срабатывание: ${formatScheduleNextFireAt(schedule.nextFireAt, schedule.timezone)}`,
    ].join("\n");
  })].join("\n");
}
function previewText(value: { value: string; truncated: boolean }): string {
  return `${value.value}${value.truncated ? "… [сокращено]" : ""}`;
}
function ideaSummaryPreviewText(value: { value: string; truncated: boolean }): string {
  const visibleText = value.value.replace(/<U\+[0-9A-F]{4,6}>/gu, "").trim();
  return visibleText ? previewText(value) : "Идея без описания";
}
function renderTaskActionPreview(preview: AssistantPendingAction["preview"]): string[] {
  if (!("kind" in preview)) {
    const action = preview.destination ? "переименовать/переместить документ" : preview.change ? "изменить документ" : "удалить документ";
    return [
      `Действие: ${action}`,
      `Документ: ${preview.path}`,
      ...(preview.destination ? [`Новое расположение: ${preview.destination}`] : []),
      ...(preview.change?.removed.value ? [`Удаляется: ${previewText(preview.change.removed)}`] : []),
      ...(preview.change?.added.value ? [`Добавляется: ${previewText(preview.change.added)}`] : []),
    ];
  }
  if (preview.kind === "delete_idea") return [`Действие: удалить идею`, `Идея: ${ideaSummaryPreviewText(preview.summary)}`];
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
      return [`Действие: ${preview.kind === "complete" ? "завершить задачу" : "отменить задачу"}`, `Задача: ${previewText(preview.taskTitle)}`];
    case "update": {
      const labels = { title: "Название", project: "Проект", type: "Тип", status: "Статус", dueDate: "Срок" } as const;
      return [
        "Действие: изменить задачу",
        `Задача: ${previewText(preview.taskTitle)}`,
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

const pendingActionGroupQuestion = "Подтвердить всё? Скажите «да», нажмите кнопку или выберите пункты словами.";
const pendingActionGroupTruncationMarker = "… [сокращено]";

function renderPendingActionItem(action: AssistantPendingAction, ordinal?: number): string[] {
  const preview = renderTaskActionPreview(action.preview);
  if (ordinal === undefined) return preview;
  return preview.map((line, index) => index === 0 ? `${ordinal}. ${line}` : `   ${line}`);
}

function pendingActionGroupText(itemLines: string[], shown: number, total: number): string {
  return [
    "Предложения:",
    ...itemLines,
    ...(shown < total ? ["", `Показано ${shown} из ${total}; остальные предложения не показаны.`] : []),
    "",
    pendingActionGroupQuestion,
  ].join("\n");
}

function plainTextFitsBudget(text: string, budget: number): boolean {
  const rendered = renderTelegramPlainText(text);
  return rendered.length === 1 && telegramMessageLength(rendered[0]!.text) <= Math.min(budget, maxTelegramMessageCharacters);
}

function boundedFirstPendingActionItem(action: AssistantPendingAction, total: number, budget: number): string[] {
  const item = renderPendingActionItem(action, 1).join("\n");
  const ordinalPrefix = "1. ";
  const body = item.startsWith(ordinalPrefix) ? item.slice(ordinalPrefix.length) : item;
  const codePoints = Array.from(body);
  const candidate = (length: number) => `${ordinalPrefix}${codePoints.slice(0, length).join("").trimEnd()}${pendingActionGroupTruncationMarker}`;
  if (!plainTextFitsBudget(pendingActionGroupText([candidate(0)], 1, total), budget)) {
    throw new RangeError("Telegram pending action group budget is too small for one bounded item");
  }
  let lower = 0;
  let upper = codePoints.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (plainTextFitsBudget(pendingActionGroupText([candidate(middle)], 1, total), budget)) lower = middle;
    else upper = middle - 1;
  }
  return candidate(lower).split("\n");
}

export type PendingActionGroupCard = {
  shown: AssistantPendingAction[];
  omitted: AssistantPendingAction[];
  text: string;
};

/** Builds one owner-visible Telegram group card without changing canonical proposals. */
export function buildPendingActionGroupCard(actions: AssistantPendingAction[], budget: number): PendingActionGroupCard {
  if (actions.length < 2) throw new RangeError("A pending action group requires at least two actions");
  if (!Number.isInteger(budget) || budget <= 0) throw new RangeError("Telegram pending action group budget must be a positive integer");
  const allItemLines = actions.flatMap((action, index) => renderPendingActionItem(action, index + 1));
  const fullText = pendingActionGroupText(allItemLines, actions.length, actions.length);
  if (plainTextFitsBudget(fullText, budget)) return { shown: [...actions], omitted: [], text: fullText };

  for (let shownCount = actions.length - 1; shownCount >= 1; shownCount -= 1) {
    const shown = actions.slice(0, shownCount);
    const text = pendingActionGroupText(shown.flatMap((action, index) => renderPendingActionItem(action, index + 1)), shownCount, actions.length);
    if (plainTextFitsBudget(text, budget)) return { shown, omitted: actions.slice(shownCount), text };
  }

  const shown = actions.slice(0, 1);
  return {
    shown,
    omitted: actions.slice(1),
    text: pendingActionGroupText(boundedFirstPendingActionItem(shown[0]!, actions.length, budget), 1, actions.length),
  };
}

export function contextDocumentDecisionText(result: ContextDocumentDecisionResult): string {
  if (result.status === "confirmed" || result.status === "already_confirmed") {
    if (result.outcome.outcome === "conflict") return "Документ изменился после предложения. Перечитайте его и подготовьте новое предложение.";
    if (result.outcome.outcome === "destination_conflict") return "Документ по новому пути уже существует. Изменение не выполнено.";
    if (result.outcome.outcome === "not_found") return "Документ не найден. Изменение не выполнено.";
    return result.status === "already_confirmed" ? "Изменение документа уже сохранено." : "Изменение документа сохранено.";
  }
  if (result.status === "rejected") return "Изменение документа отклонено.";
  if (result.status === "already_rejected") return "Изменение документа уже отклонено.";
  if (result.status === "expired") return "Срок подтверждения истёк. Документ не изменён.";
  if (result.status === "owner_mismatch") return "Предложение принадлежит другому владельцу. Документ не изменён.";
  if (result.status === "invalid_payload") return "Предложение повреждено или устарело. Документ не изменён.";
  return "Предложение не найдено. Документ не изменён.";
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
    if (progress.choiceValues && progress.choiceValues.length !== progress.choices.length) throw new Error("onboarding choice labels and values must have equal length");
    const choices = progress.choices.map((choice, index) => {
      const value = progress.choiceValues?.[index] ?? (progress.field === "roleId" ? choice : onboardingChoiceValue(progress.field, choice));
      return { text: choice, callbackData: onboardingCallbackData(progress.field, value) };
    }).filter((choice): choice is { text: string; callbackData: string } => Boolean(choice.callbackData));
    const inlineKeyboard = progress.field === "timezone"
      ? [choices.slice(0, 2), choices.slice(2, 4), choices.slice(4, 6), choices.slice(6, 8), choices.slice(8)]
      : choices.map((choice) => [choice]);
    await replyPort.sendMessage(chatId, progress.prompt, { replyMarkup: { inlineKeyboard } });
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
      await replyPort.sendMessage(chatId, ["Проверьте, пожалуйста:", `- должность: ${summary.roleName};`, `- обращаться к вам: ${summary.preferredName};`, `- имя ассистента: ${summary.assistantName};`, `- форма обращения: ${summary.addressForm};`, `- стиль: ${summary.persona};`, `- длина ответов: ${summary.responseLength};`, `- часовой пояс: ${summary.timezone} (сейчас у вас ${currentTimeInTimezone(summary.timezone)}).`, "", "Всё верно?"].join("\n"), { replyMarkup: { inlineKeyboard: [[{ text: "✅ Подтвердить", callbackData: onboardingCallbackData("confirm")! }, { text: "✏️ Исправить", callbackData: onboardingCallbackData("reset")! }]] } });
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

export type TelegramArtifactIntake = {
  checkArtifactCapacity?(input: { ownerId: string; deliveryKey: string; size: number }): Promise<unknown>;
  saveArtifact(input: SaveArtifactInput): Promise<SaveArtifactResult>;
};

export async function deliverTelegramMessage(replyPort: TelegramReplyPort, chatId: string, text: string): Promise<void> {
  const chunks = renderTelegramMarkdown(text);
  if (!chunks.length) throw new Error("Telegram delivery text is required");
  for (const chunk of chunks) await replyPort.sendMessage(chatId, chunk.text, { parseMode: chunk.parseMode });
}

export function createTelegramShell(deps: { client: ServiceMinutkaClient; sessionStore: TelegramSessionStore; pendingActionGroupStore?: PendingActionGroupStore; replyPort: TelegramReplyPort; privacyExplanation: string; now?: () => string; artifactIntake?: TelegramArtifactIntake; fileGateway?: TelegramFileGateway; artifactMaximumBytes?: number; speechToText?: SpeechToTextPort; voiceFileGateway?: TelegramVoiceFileGateway; voiceProcessingTimeoutMs?: number }) {
  const { client, sessionStore, artifactIntake, fileGateway, speechToText, voiceFileGateway } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const pendingActionGroupStore = deps.pendingActionGroupStore ?? createInMemoryPendingActionGroupStore();
  const privacyExplanation = deps.privacyExplanation.trim();
  if (!privacyExplanation) throw new Error("privacyExplanation is required");
  const rawReplyPort = deps.replyPort;
  const voiceTimeoutMs = deps.voiceProcessingTimeoutMs ?? defaultVoiceProcessingTimeoutMs;
  const artifactMaximumBytes = deps.artifactMaximumBytes ?? maxTelegramArtifactFileSizeBytes;
  if (!Number.isSafeInteger(artifactMaximumBytes) || artifactMaximumBytes <= 0) throw new Error("artifactMaximumBytes must be a positive safe integer");
  const inFlightChatCounts = new Map<string, number>();
  const activeActionMessageIds = new Map<string, number>();
  const activePendingActions = new Map<string, ActivePendingAction>();
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
      if (activePendingActions.get(chatId)?.messageId === messageId) activePendingActions.delete(chatId);
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
  async function runCallbackAction<T>(input: { chatId: string; userId?: string; employeeId: string; messageId?: number; callbackQueryId: string; action: () => Promise<T>; repeatedText?: string; isCompleted?: (result: T) => boolean }): Promise<{ repeated: true } | { repeated: false; result: T }> {
    const { chatId, userId, employeeId, messageId, callbackQueryId, action, repeatedText = "Уже обработано.", isCompleted = () => true } = input;
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
      if (isCompleted(result)) {
        await sessionStore.completeActionMessage({ identity: telegramIdentity, employeeId, messageId, claimedAt });
        completed = true;
      } else {
        await sessionStore.releaseActionMessage({ identity: telegramIdentity, employeeId, messageId, claimedAt });
        claimAcquired = false;
      }
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
  async function decidePendingAction(employeeId: string, action: AssistantPendingAction, decision: TextConfirmationDecision): Promise<TaskMutationDecisionResult | IdeaDeletionDecisionResult | ContextDocumentDecisionResult> {
    if (action.actionKind === "delete_idea") return await (decision === "confirm"
      ? employeeClient(employeeId).confirmIdeaDeletion(action.confirmationId)
      : employeeClient(employeeId).rejectIdeaDeletion(action.confirmationId)) as IdeaDeletionDecisionResult;
    if (action.actionKind === "update" || action.actionKind === "move" || action.actionKind === "delete") return decision === "confirm"
      ? employeeClient(employeeId).confirmContextDocumentMutation(action.confirmationId)
      : employeeClient(employeeId).rejectContextDocumentMutation(action.confirmationId);
    return decision === "confirm"
      ? employeeClient(employeeId).confirmTaskMutation(action.confirmationId)
      : employeeClient(employeeId).rejectTaskMutation(action.confirmationId);
  }
  async function rejectPendingActions(employeeId: string, actions: AssistantPendingAction[]): Promise<"cancelled"> {
    try {
      const results = await Promise.all(actions.map((action) => decidePendingAction(employeeId, action, "reject")));
      if (results.every(({ status }) => status === "rejected" || status === "already_rejected" || status === "not_found")) return "cancelled";
    } catch (error) {
      logShellError("task proposal terminal rejection", error);
    }
    throw new TaskProposalTerminalizationUnknownError();
  }
  async function sendTaskProposal(chatId: string, chat: TelegramChatDeliveryResult, employeeId: string): Promise<"delivered" | "cancelled" | "shown_cancelled"> {
    const actions = chat.pendingActions;
    if (!actions.length) return "delivered";
    const grouped = actions.length > 1;
    const groupCard = grouped ? buildPendingActionGroupCard(actions, maxTelegramMessageCharacters) : undefined;
    const shownActions = groupCard?.shown ?? actions;
    const omittedActions = groupCard?.omitted ?? [];
    const groupId = grouped ? randomUUID().replaceAll("-", "").slice(0, 24) : undefined;
    const trackForTextDecision = grouped || isLevelOnePendingAction(shownActions[0]!);
    const question = trackForTextDecision
      ? "Подтвердить действие? Скажите «да» или нажмите кнопку."
      : "Подтвердить изменение?";
    const text = groupCard?.text
      ?? ["Предложение:", ...renderPendingActionItem(shownActions[0]!), "", question].join("\n");
    const replyMarkup = grouped ? pendingActionGroupReplyMarkup(groupId!) : pendingActionReplyMarkup(shownActions[0]!);
    if (grouped) {
      const createdAt = now();
      await pendingActionGroupStore.create({
        groupId: groupId!,
        ownerId: employeeId,
        items: shownActions.map((action, index) => ({ ordinal: (index + 1) as PendingActionGroupOrdinal, action, state: "pending" })),
        createdAt,
        expiresAt: new Date(Math.max(...shownActions.map(({ expiresAt }) => Date.parse(expiresAt)))).toISOString(),
      });
    }
    const rendered = renderTelegramPlainText(text);
    if (rendered.length !== 1) throw new Error("Telegram task proposal exceeds one message");
    let sent: TelegramSentMessage | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        sent = await rawReplyPort.sendMessage(chatId, rendered[0]!.text, { replyMarkup, parseMode: rendered[0]!.parseMode });
        break;
      } catch (error) {
        logShellError("task proposal delivery", error);
      }
    }
    if (sent) {
      if (grouped || trackForTextDecision) activeActionMessageIds.set(chatId, sent.messageId);
      if (grouped) {
        const delivered = await pendingActionGroupStore.markDelivered({ ownerId: employeeId, groupId: groupId!, messageId: sent.messageId });
        if (!delivered) throw new Error("Telegram pending action group delivery binding failed");
      } else if (trackForTextDecision) activePendingActions.set(chatId, { action: shownActions[0]!, messageId: sent.messageId });
      return "delivered";
    }
    await rejectPendingActions(employeeId, shownActions);
    if (grouped) await pendingActionGroupStore.cancel(employeeId, groupId!);
    return omittedActions.length ? "shown_cancelled" : "cancelled";
  }
  async function deliverChatResult(chatId: string, chat: Omit<TelegramChatDeliveryResult, "pendingActions"> & { pendingActions?: AssistantPendingAction[] }, employeeId: string): Promise<void> {
    const pendingActions = chat.pendingActions ?? [];
    if (!chat.response.trim()) throw new Error("Agent returned an empty response");
    const feedbackMessageId = chat.messageId;
    const feedbackMarkup = feedbackMessageId === undefined ? undefined : { inlineKeyboard: [["positive", "neutral", "negative"].map((rating) => ({ text: rating === "positive" ? "👍" : rating === "neutral" ? "👌" : "👎", callbackData: encodeFeedbackCallbackData(rating as "positive" | "neutral" | "negative", feedbackMessageId) }))] };
    if (pendingActions.length) {
      await removeActiveReplyMarkup(chatId);
      const delivery = await sendTaskProposal(chatId, { ...chat, pendingActions }, employeeId);
      if (delivery === "cancelled") await replyPort.sendMessage(chatId, taskProposalCancelledMessage);
      else if (delivery === "shown_cancelled") await replyPort.sendMessage(chatId, "Не удалось доставить показанные предложения. Они отменены; остальные предложения не отклонены и останутся доступными до истечения срока.");
      return;
    }
    if (activePendingActions.has(chatId) || await pendingActionGroupStore.getLatestDelivered(employeeId)) await sendMarkdown(chatId, chat.response);
    else {
      await removeActiveReplyMarkup(chatId);
      await sendMarkdown(chatId, chat.response, feedbackMarkup ? { replyMarkup: feedbackMarkup } : undefined);
    }
  }
  async function textDecisionAction(employeeId: string, pending: ActivePendingAction, decision: TextConfirmationDecision): Promise<TaskMutationDecisionResult | IdeaDeletionDecisionResult | ContextDocumentDecisionResult> {
    return decidePendingAction(employeeId, pending.action, decision);
  }
  function textDecisionText(action: ActivePendingAction["action"], result: TaskMutationDecisionResult | IdeaDeletionDecisionResult | ContextDocumentDecisionResult): string {
    if (action.actionKind === "delete_idea") {
      const ideaResult = result as IdeaDeletionDecisionResult;
      if (ideaResult.status === "confirmed") return "Идея удалена. Можно отменить удаление командой «верни последнюю идею».";
      if (ideaResult.status === "already_confirmed") return "Идея уже удалена.";
      if (ideaResult.status === "rejected" || ideaResult.status === "already_rejected") return "Удаление отменено.";
      if (ideaResult.status === "expired") return "Время подтверждения истекло.";
      return "Идея не найдена.";
    }
    if (action.actionKind === "move" || action.actionKind === "delete") return contextDocumentDecisionText(result as ContextDocumentDecisionResult);
    return taskDecisionText(result as TaskMutationDecisionResult);
  }
  function groupDecisionLine(ordinal: PendingActionGroupOrdinal, action: AssistantPendingAction, result: TaskMutationDecisionResult | IdeaDeletionDecisionResult | ContextDocumentDecisionResult): string {
    return `${ordinal}. ${textDecisionText(action, result)}`;
  }
  function pendingGroupItems(group: PendingActionGroup): PendingActionGroupItem[] {
    return group.items.filter((item) => item.state === "pending");
  }
  function resolvedGroupOrdinals(outcomes: GroupDecisionOutcome[]): PendingActionGroupOrdinal[] {
    return outcomes.filter((outcome) => outcome.state === "resolved").map((outcome) => outcome.ordinal);
  }
  function groupResultText(outcomes: GroupDecisionOutcome[], remaining: PendingActionGroupItem[]): string {
    return [
      "Результат:",
      ...outcomes.map((outcome) => outcome.line),
      ...(remaining.length ? [
        `Осталось без решения: ${remaining.length}.`,
        "Нерешённые пункты (исходные номера):",
        ...remaining.flatMap((item) => renderPendingActionItem(item.action, item.ordinal)),
      ] : []),
    ].join("\n");
  }
  async function applyGroupSelection(employeeId: string, group: ActivePendingActionGroup, selection: TextConfirmationSelection): Promise<GroupDecisionOutcome[]> {
    const decisions = new Map<number, TextConfirmationDecision>();
    for (const index of selection.confirm) decisions.set(index + 1, "confirm");
    for (const index of selection.reject) decisions.set(index + 1, "reject");
    const outcomes: GroupDecisionOutcome[] = [];
    for (const [ordinal, decision] of [...decisions.entries()].sort(([left], [right]) => left - right)) {
      const item = group.items.find((candidate) => candidate.ordinal === ordinal && candidate.state === "pending");
      if (!item) continue;
      try {
        outcomes.push({ ordinal: item.ordinal, state: "resolved", line: groupDecisionLine(item.ordinal, item.action, await decidePendingAction(employeeId, item.action, decision)) });
      } catch (error) {
        logShellError("group decision", error);
        outcomes.push({ ordinal: item.ordinal, state: "retryable", line: `${item.ordinal}. Не удалось обработать действие; его можно повторить.` });
      }
    }
    return outcomes;
  }
  async function resolveTextDecision(chatId: string, text: string, employeeId: string): Promise<boolean> {
    const group = await pendingActionGroupStore.getLatestDelivered(employeeId);
    if (group?.messageId !== undefined) {
      const highestOrdinal = group.items.at(-1)?.ordinal;
      if (highestOrdinal === undefined) return false;
      const selection = classifyTextConfirmationSelection(text, highestOrdinal);
      if (!selection) return false;
      const deliveredGroup = group as ActivePendingActionGroup;
      const outcomes = await applyGroupSelection(employeeId, deliveredGroup, selection);
      const updatedGroup = await pendingActionGroupStore.markItemsResolved({ ownerId: employeeId, groupId: group.groupId, ordinals: resolvedGroupOrdinals(outcomes) }) ?? deliveredGroup;
      const remaining = pendingGroupItems(updatedGroup);
      if (!remaining.length) {
        await pendingActionGroupStore.complete(employeeId, group.groupId);
        await removeReplyMarkup(chatId, group.messageId);
      }
      await replyPort.sendMessage(chatId, groupResultText(outcomes, remaining));
      return true;
    }
    const pending = activePendingActions.get(chatId);
    if (!pending || !isLevelOnePendingAction(pending.action)) return false;
    const decision = classifyTextConfirmation(text);
    if (!decision) return false;
    const result = await textDecisionAction(employeeId, pending, decision);
    await removeReplyMarkup(chatId, pending.messageId);
    await replyPort.sendMessage(chatId, textDecisionText(pending.action, result));
    return true;
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
    async deliverReminder(chatId: string, text: string, employeeId: string) {
      await deliverChatResult(chatId, { response: text, pendingActions: [] }, employeeId);
    },
    async handleStart(chatId: string, inviteCode?: string, userId?: string) {
      await removeActiveReplyMarkup(chatId);
      try {
        if (!userId) return void await replyPort.sendMessage(chatId, "Не удалось определить аккаунт Telegram.");
        const telegramIdentity = identity(chatId, userId); const existing = await getLinkedSession(chatId, userId);
        if (existing) {
          if (!existing.consentAcceptedAt || existing.consentPrivacyVersion !== currentPrivacyVersion) { await sendConsentPrompt(replyPort, chatId, existing.employeeId, privacyExplanation); await employeeClient(existing.employeeId).recordPrivacyExplanationShown(); return; }
          try {
            await employeeClient(existing.employeeId).getProfile();
            return void await replyPort.sendMessage(chatId, "Вы уже зарегистрированы. Вы можете общаться с ботом.");
          } catch (error) {
            if (!((error instanceof PersistenceError || error instanceof MinutkaApiError) && error.code === "profile_not_found")) throw error;
          }
          await replyPort.sendMessage(chatId, onboardingIntroduction);
          return renderOnboardingProgress(replyPort, chatId, await employeeClient(existing.employeeId).getOnboardingProgress(), onboardingConfirmationDelivery(chatId, userId, existing.employeeId), sendMarkdown);
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
        const trimmed = text.trim(); if (!trimmed) return void await replyPort.sendMessage(chatId, "Сообщение не может быть пустым."); if (!chatInputFitsCharacterLimit(trimmed)) return void await replyPort.sendMessage(chatId, `Сообщение слишком длинное (максимум ${maxChatInputCharacters} символов).`);
        const session = await authorizedSession(chatId, userId); if (!session) return;
        if (await resolveTextDecision(chatId, trimmed, session.employeeId)) return;
        if (!activePendingActions.has(chatId) && !(await pendingActionGroupStore.getLatestDelivered(session.employeeId))) await removeActiveReplyMarkup(chatId);
        await withTypingIndicator(replyPort, chatId, () => dispatchText(chatId, trimmed, session, "text", userId));
      } catch (error) { logShellError("text message", error); await replyPort.sendMessage(chatId, error instanceof TaskProposalTerminalizationUnknownError ? taskProposalTerminalizationUnknownMessage : mutationOutcomeUserMessage(error) ?? contextOverflowUserMessage(error) ?? "Не удалось обработать сообщение. Попробуйте ещё раз позже."); } finally { leaveChat(chatId); }
    },
    async handleFile(chatId: string, attachment: TelegramFileAttachment, userId?: string) {
      if (isChatInFlight(chatId)) return void await replyPort.sendMessage(chatId, inFlightDeliveryMessage); enterChat(chatId);
      try {
        await removeActiveReplyMarkup(chatId);
        const session = await authorizedSession(chatId, userId); if (!session) return;
        if (!artifactIntake || !fileGateway) return void await replyPort.sendMessage(chatId, "Сохранение файлов сейчас недоступно. Попробуйте ещё раз позже.");
        if (attachment.fileSizeBytes !== undefined && attachment.fileSizeBytes > artifactMaximumBytes) {
          logArtifactRejection("object_limit");
          return void await replyPort.sendMessage(chatId, artifactObjectLimitMessage(artifactMaximumBytes));
        }
        const deliveryKey = `telegram:${chatId}:${attachment.messageId}:${attachment.payloadKind}:${attachment.fileUniqueId ?? attachment.fileId}`;
        if (attachment.fileSizeBytes !== undefined) await artifactIntake.checkArtifactCapacity?.({ ownerId: session.employeeId, deliveryKey, size: attachment.fileSizeBytes });
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
        if (error instanceof ArtifactTooLargeError) logArtifactRejection("object_limit");
        else if (error instanceof ArtifactOwnerQuotaExceededError) logArtifactRejection("owner_quota");
        else if (error instanceof ArtifactGlobalCapacityExceededError) logArtifactRejection("global_capacity");
        const message = error instanceof ArtifactTooLargeError ? artifactObjectLimitMessage(artifactMaximumBytes)
          : error instanceof ArtifactOwnerQuotaExceededError ? "Квота хранения файлов для вашего профиля исчерпана. Обратитесь к оператору пилота."
          : error instanceof ArtifactGlobalCapacityExceededError ? "Сохранение новых файлов временно приостановлено из-за общей ёмкости хранилища. Обратитесь к оператору пилота."
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
          try {
            await replyPort.sendMessage(chatId, onboardingIntroduction);
            await renderOnboardingProgress(replyPort, chatId, await employeeClient(employeeId).getOnboardingProgress(), onboardingConfirmationDelivery(chatId, userId, employeeId), sendMarkdown);
          } catch (error) { logShellError("consent follow-up delivery", error); }
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
          if ((action === "roleId" || action === "addressForm" || action === "persona" || action === "responseLength" || action === "timezone") && value) {
            if (action === "timezone" && value === "other") {
              await replyPort.answerCallbackQuery(callbackQueryId, "Напишите город или смещение UTC.");
              if (messageId !== undefined) await removeReplyMarkup(chatId, messageId);
              await replyPort.sendMessage(chatId, "Напишите ваш город, IANA timezone или смещение, например UTC+3.");
              return;
            }
            const handled = await runCallbackAction({ chatId, userId, employeeId: session.employeeId, messageId, callbackQueryId, action: () => employeeClient(session.employeeId).submitOnboardingAnswer({ text: value }) });
            if (handled.repeated) return;
            await replyPort.answerCallbackQuery(callbackQueryId);
            if (messageId !== undefined) await removeReplyMarkup(chatId, messageId);
            return renderOnboardingProgress(replyPort, chatId, handled.result, onboardingConfirmationDelivery(chatId, userId, session.employeeId), sendMarkdown);
          }
          return void await replyPort.answerCallbackQuery(callbackQueryId, "Неизвестное действие.");
        }
        if (data.startsWith("gp:")) {
          const decoded = decodePendingActionGroupCallbackData(data);
          if (!decoded) return void await replyPort.answerCallbackQuery(callbackQueryId, "Неверный формат действия.");
          if (!session) { const existingChat = await sessionStore.getByIdentity(identity(chatId)); return void await replyPort.answerCallbackQuery(callbackQueryId, existingChat ? "Этот аккаунт не связан с данным чатом." : "Сессия не найдена. Выполните /start."); }
          if (!session.consentAcceptedAt || session.consentPrivacyVersion !== currentPrivacyVersion) return void await replyPort.answerCallbackQuery(callbackQueryId, "Сначала подтвердите согласие с политикой конфиденциальности.");
          const storedGroup = await pendingActionGroupStore.get(session.employeeId, decoded.groupId);
          if (storedGroup?.state === "completed" && messageId !== undefined && storedGroup.messageId === messageId) {
            await replyPort.answerCallbackQuery(callbackQueryId, "Уже обработано.");
            await removeReplyMarkup(chatId, messageId);
            return;
          }
          if (!storedGroup || storedGroup.state === "completed" || storedGroup.state === "cancelled" || messageId === undefined) return void await replyPort.answerCallbackQuery(callbackQueryId, "Группа предложений не найдена.");
          const group = storedGroup.state === "preparing"
            ? await pendingActionGroupStore.markDelivered({ ownerId: session.employeeId, groupId: decoded.groupId, messageId })
            : storedGroup.messageId === messageId ? storedGroup : undefined;
          if (!group || group.state !== "delivered" || group.messageId !== messageId) return void await replyPort.answerCallbackQuery(callbackQueryId, "Группа предложений не найдена.");
          const deliveredGroup = group as ActivePendingActionGroup;
          const pending = pendingGroupItems(deliveredGroup);
          const handled = await runCallbackAction({
            chatId, userId, employeeId: session.employeeId, messageId, callbackQueryId,
            action: () => applyGroupSelection(session.employeeId, deliveredGroup, decoded.action === "confirm"
              ? { confirm: pending.map((item) => item.ordinal - 1), reject: [] }
              : { confirm: [], reject: pending.map((item) => item.ordinal - 1) }),
            repeatedText: "Уже обработано.",
            isCompleted: (outcomes) => outcomes.every((outcome) => outcome.state === "resolved"),
          });
          if (handled.repeated) return;
          const updatedGroup = await pendingActionGroupStore.markItemsResolved({ ownerId: session.employeeId, groupId: deliveredGroup.groupId, ordinals: resolvedGroupOrdinals(handled.result) }) ?? deliveredGroup;
          const remaining = pendingGroupItems(updatedGroup);
          if (!remaining.length) {
            await pendingActionGroupStore.complete(session.employeeId, group.groupId);
            await removeReplyMarkup(chatId, messageId);
          }
          try { await replyPort.answerCallbackQuery(callbackQueryId, remaining.length ? "Часть группы не обработана; можно повторить." : "Группа обработана."); }
          catch (error) { logShellError("group decision callback answer", error); }
          await replyPort.sendMessage(chatId, groupResultText(handled.result, remaining));
          return;
        }
        if (data.startsWith("tm:") || data.startsWith("id:") || data.startsWith("cd:")) {
          const ideaDeletion = data.startsWith("id:");
          const contextDocumentMutation = data.startsWith("cd:");
          const decoded = ideaDeletion
            ? decodeIdeaDeletionCallbackData(data)
            : contextDocumentMutation ? decodeContextDocumentMutationCallbackData(data) : decodeTaskMutationCallbackData(data);
          if (!decoded) return void await replyPort.answerCallbackQuery(callbackQueryId, "Неверный формат действия.");
          if (!session) { const existingChat = await sessionStore.getByIdentity(identity(chatId)); return void await replyPort.answerCallbackQuery(callbackQueryId, existingChat ? "Этот аккаунт не связан с данным чатом." : "Сессия не найдена. Выполните /start."); }
          if (!session.consentAcceptedAt || session.consentPrivacyVersion !== currentPrivacyVersion) return void await replyPort.answerCallbackQuery(callbackQueryId, "Сначала подтвердите согласие с политикой конфиденциальности.");
          const action = ideaDeletion
            ? () => decoded.action === "confirm"
              ? employeeClient(session.employeeId).confirmIdeaDeletion(decoded.confirmationId)
              : employeeClient(session.employeeId).rejectIdeaDeletion(decoded.confirmationId)
            : contextDocumentMutation
              ? () => decoded.action === "confirm"
                ? employeeClient(session.employeeId).confirmContextDocumentMutation(decoded.confirmationId)
                : employeeClient(session.employeeId).rejectContextDocumentMutation(decoded.confirmationId)
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
            : contextDocumentMutation
              ? contextDocumentDecisionText(handled.result as ContextDocumentDecisionResult)
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
        logShellError("callback", error); await replyPort.answerCallbackQuery(callbackQueryId, data.startsWith("tg:consent:") ? "Не удалось сохранить согласие. Попробуйте ещё раз позже." : data.startsWith("ob:") ? "Не удалось сохранить профиль. Попробуйте ещё раз позже." : data.startsWith("gp:") || data.startsWith("tm:") || data.startsWith("id:") || data.startsWith("cd:") ? "Не удалось обработать предложение. Попробуйте ещё раз позже." : "Не удалось сохранить отзыв. Попробуйте ещё раз позже.");
      } finally {
        const remaining = leaveChat(chatId);
        if (remaining === 0 && actionKey && callbackActionKeys.get(chatId) === actionKey) callbackActionKeys.delete(chatId);
      }
    },
  };
}
