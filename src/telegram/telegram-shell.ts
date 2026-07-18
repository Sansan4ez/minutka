import type { ServiceMinutkaClient } from "../client/sdk/minutka-client.js";
import { MinutkaApiError } from "../client/sdk/http-transport.js";
import type { OnboardingProgressResult } from "../client/sdk/minutka-client.js";
import { telegramActionMessageClaimLeaseMilliseconds, type TelegramIdentity, type TelegramSessionStore } from "./telegram-session-store.js";
import type { TelegramReplyPort } from "./telegram-types.js";
import { decodeFeedbackCallbackData, encodeFeedbackCallbackData } from "./callback-data.js";
import { currentPrivacyVersion, privacyExplanation } from "../domain/privacy.js";
import { PersistenceError } from "../application/persistence-error.js";
import { voiceProcessingTimeoutMs as defaultVoiceProcessingTimeoutMs, type SpeechToTextPort } from "../application/speech-to-text.js";
import type { TelegramVoiceFileGateway } from "./telegram-voice-file-gateway.js";
import { ArtifactSaveTimeoutError, ArtifactTooLargeError } from "../application/artifact-body-stager.js";
import type { SaveArtifactInput, SaveArtifactResult, TelegramArtifactPayloadKind } from "../application/artifact-store.js";
import type { TelegramFileGateway } from "./telegram-file-gateway.js";
import { randomUUID } from "node:crypto";
import { pipeline, Transform } from "node:stream";

export const maxTelegramMessageCharacters = 4_000;
const telegramPreferredSplitBoundaries = ["\n\n", "\n", ". ", "! ", "? ", "; ", ", ", " "] as const;

export function telegramMessageLength(text: string): number { return text.length; }

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
  void replyPort.sendChatAction(chatId, "typing").catch(() => undefined);
  const refresh = setInterval(() => { void replyPort.sendChatAction(chatId, "typing").catch(() => undefined); }, typingRefreshMilliseconds);
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
async function sendVoiceTranscript(replyPort: TelegramReplyPort, chatId: string, transcript: string, replyToMessageId: number): Promise<void> {
  // Telegram cannot render a bot-received voice message as a user text message.
  // Reply to its source voice message so the employee can still see the
  // relationship between the original input and text sent to the agent.
  for (const chunk of splitTelegramMessage(`Распознано:\n${transcript}`)) await replyPort.sendMessage(chatId, chunk, { replyToMessageId });
}
async function renderOnboardingProgress(replyPort: TelegramReplyPort, chatId: string, progress: OnboardingProgressResult, confirmationDelivery?: { claim(deliveryKey: string): Promise<{ status: "claimed"; claimedAt: string } | { status: "already_claimed" }>; complete(deliveryKey: string, claimedAt: string): Promise<void>; release(deliveryKey: string, claimedAt: string): Promise<void> }): Promise<void> {
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
  for (const chunk of splitTelegramMessage(response)) await replyPort.sendMessage(chatId, chunk);
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

export function createTelegramShell(deps: { client: ServiceMinutkaClient; sessionStore: TelegramSessionStore; replyPort: TelegramReplyPort; artifactIntake?: TelegramArtifactIntake; fileGateway?: TelegramFileGateway; speechToText?: SpeechToTextPort; voiceFileGateway?: TelegramVoiceFileGateway; voiceProcessingTimeoutMs?: number }) {
  const { client, sessionStore, artifactIntake, fileGateway, speechToText, voiceFileGateway } = deps;
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
  const replyPort: TelegramReplyPort = {
    async sendMessage(chatId, text, options) {
      if (options?.replyMarkup) await removeActiveReplyMarkup(chatId);
      const sent = await rawReplyPort.sendMessage(chatId, text, options);
      if (options?.replyMarkup) activeActionMessageIds.set(chatId, sent.messageId);
      return sent;
    },
    editReplyMarkup: (chatId, messageId, replyMarkup) => rawReplyPort.editReplyMarkup(chatId, messageId, replyMarkup),
    sendChatAction: (chatId, action) => rawReplyPort.sendChatAction(chatId, action),
    answerCallbackQuery: (callbackQueryId, text) => rawReplyPort.answerCallbackQuery(callbackQueryId, text),
  };
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
    const claimedAt = new Date().toISOString();
    const staleBefore = new Date(Date.parse(claimedAt) - telegramActionMessageClaimLeaseMilliseconds).toISOString();
    const telegramIdentity = identity(chatId, userId);
    const claim = await sessionStore.claimActionMessage({ identity: telegramIdentity, employeeId, messageId, claimedAt, staleBefore });
    if (claim.status === "already_claimed") {
      await replyPort.answerCallbackQuery(callbackQueryId, repeatedText);
      await removeReplyMarkup(chatId, messageId);
      return { repeated: true };
    }
    const actionPromise = action();
    const completion = actionPromise.then(() => true, () => false);
    inFlightActionMessages.set(key, completion);
    try {
      const result = await actionPromise;
      await sessionStore.completeActionMessage({ identity: telegramIdentity, employeeId, messageId, claimedAt });
      return { repeated: false, result };
    } catch (error) {
      await sessionStore.releaseActionMessage({ identity: telegramIdentity, employeeId, messageId, claimedAt }).catch((releaseError) => logShellError("action message claim release", releaseError));
      throw error;
    } finally {
      if (inFlightActionMessages.get(key) === completion) inFlightActionMessages.delete(key);
    }
  }
  async function authorizedSession(chatId: string, userId?: string) {
    const session = await sessionStore.getByIdentity(identity(chatId, userId));
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
  async function dispatchText(chatId: string, text: string, session: { employeeId: string; threadId: string }, inputModality: "text" | "voice", userId?: string) {
    let profileExists = true;
    try { await employeeClient(session.employeeId).getProfile(); } catch (error) { if ((error instanceof PersistenceError || error instanceof MinutkaApiError) && error.code === "profile_not_found") profileExists = false; else throw error; }
    if (!profileExists) return renderOnboardingProgress(replyPort, chatId, await employeeClient(session.employeeId).submitOnboardingAnswer({ text }), onboardingConfirmationDelivery(chatId, userId, session.employeeId));
    const chat = await withTypingIndicator(replyPort, chatId, () => employeeClient(session.employeeId).chat({ threadId: session.threadId, text, inputModality, responseChannel: "telegram" }));
    const chunks = splitTelegramMessage(chat.response); if (!chat.response.trim()) throw new Error("Agent returned an empty response");
    const replyMarkup = { inlineKeyboard: [["positive", "neutral", "negative"].map((rating) => ({ text: rating === "positive" ? "👍" : rating === "neutral" ? "👌" : "👎", callbackData: encodeFeedbackCallbackData(rating as "positive" | "neutral" | "negative", chat.messageId) }))] };
    for (const [index, chunk] of chunks.entries()) await replyPort.sendMessage(chatId, chunk, index === chunks.length - 1 ? { replyMarkup } : undefined);
  }
  return {
    async handleStart(chatId: string, inviteCode?: string, userId?: string) {
      await removeActiveReplyMarkup(chatId);
      try {
        if (!userId) return void await replyPort.sendMessage(chatId, "Не удалось определить аккаунт Telegram.");
        const telegramIdentity = identity(chatId, userId); const existing = await sessionStore.getByIdentity(telegramIdentity);
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
    async handleText(chatId: string, text: string, userId?: string) {
      if (isChatInFlight(chatId)) return void await replyPort.sendMessage(chatId, inFlightDeliveryMessage); enterChat(chatId);
      try {
        await removeActiveReplyMarkup(chatId);
        const trimmed = text.trim(); if (!trimmed) return void await replyPort.sendMessage(chatId, "Сообщение не может быть пустым."); if (Array.from(trimmed).length > 4096) return void await replyPort.sendMessage(chatId, "Сообщение слишком длинное (максимум 4096 символов).");
        const session = await authorizedSession(chatId, userId); if (!session) return; await dispatchText(chatId, trimmed, session, "text", userId);
      } catch (error) { logShellError("text message", error); await replyPort.sendMessage(chatId, "Не удалось обработать сообщение. Попробуйте ещё раз позже."); } finally { leaveChat(chatId); }
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
          const transcript = (await withTypingIndicator(replyPort, chatId, () => withVoiceTimeout(voiceTimeoutMs, async (signal) => {
            file = await voiceFileGateway.openVoiceFile(voice.fileId, signal);
            audio = voice.fileSizeBytes === undefined ? limitVoiceStream(file.stream, maxVoiceFileSizeBytes) : file.stream;
            signal.addEventListener("abort", () => {
              if (audio) destroyStream(audio);
              if (audio && audio !== file?.stream) destroyStream(file!.stream);
            }, { once: true });
            return speechToText.transcribe({ audio, filetype: file.filetype, signal });
          }))).trim();
          if (!transcript) return void await replyPort.sendMessage(chatId, "Не удалось распознать голосовое сообщение. Попробуйте ещё раз или напишите текстом.");
          if (Array.from(transcript).length > 4096) return void await replyPort.sendMessage(chatId, "Сообщение слишком длинное (максимум 4096 символов).");
          await sendVoiceTranscript(replyPort, chatId, transcript, voice.messageId);
          await dispatchText(chatId, transcript, session, "voice", userId);
        } finally {
          // A provider can fail before consuming the download; close it promptly.
          if (audio) destroyStream(audio);
          if (audio && audio !== file?.stream) destroyStream(file!.stream);
        }
      } catch (error) { logShellError("voice message", error); await replyPort.sendMessage(chatId, error instanceof VoiceFileTooLargeError ? "Голосовое сообщение слишком большое (максимум 20 МБ)." : "Не удалось обработать голосовое сообщение. Попробуйте ещё раз позже."); } finally { leaveChat(chatId); }
    },
    async handleCallback(chatId: string, callbackQueryId: string, data: string, userId?: string, messageId?: number) {
      const actionKey = messageId === undefined ? undefined : `${chatId}:${messageId}`;
      const existingActionKey = callbackActionKeys.get(chatId);
      if (isChatInFlight(chatId) && (!actionKey || existingActionKey !== actionKey)) return void await replyPort.answerCallbackQuery(callbackQueryId, inFlightDeliveryMessage);
      enterChat(chatId);
      if (actionKey) callbackActionKeys.set(chatId, actionKey);
      try {
        const telegramIdentity = identity(chatId, userId); const session = await sessionStore.getByIdentity(telegramIdentity);
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
            for (const chunk of splitTelegramMessage(handled.result.firstResponse)) await replyPort.sendMessage(chatId, chunk);
            return;
          }
          if (action === "reset" && !value) {
            const handled = await runCallbackAction({ chatId, userId, employeeId: session.employeeId, messageId, callbackQueryId, action: () => employeeClient(session.employeeId).submitOnboardingAnswer({ text: "Исправить" }) });
            if (handled.repeated) return;
            await replyPort.answerCallbackQuery(callbackQueryId, "Что нужно исправить?");
            if (messageId !== undefined) await removeReplyMarkup(chatId, messageId);
            return renderOnboardingProgress(replyPort, chatId, handled.result, onboardingConfirmationDelivery(chatId, userId, session.employeeId));
          }
          if ((action === "addressForm" || action === "persona" || action === "responseLength") && value) {
            const handled = await runCallbackAction({ chatId, userId, employeeId: session.employeeId, messageId, callbackQueryId, action: () => employeeClient(session.employeeId).submitOnboardingAnswer({ text: value }) });
            if (handled.repeated) return;
            await replyPort.answerCallbackQuery(callbackQueryId);
            if (messageId !== undefined) await removeReplyMarkup(chatId, messageId);
            return renderOnboardingProgress(replyPort, chatId, handled.result, onboardingConfirmationDelivery(chatId, userId, session.employeeId));
          }
          return void await replyPort.answerCallbackQuery(callbackQueryId, "Неизвестное действие.");
        }
        if (!data.startsWith("fb:")) return void await replyPort.answerCallbackQuery(callbackQueryId, "Неизвестное действие."); const decoded = decodeFeedbackCallbackData(data); if (!decoded) return void await replyPort.answerCallbackQuery(callbackQueryId, "Неверный формат отзыва.");
        if (!session) { const existingChat = await sessionStore.getByIdentity(identity(chatId)); return void await replyPort.answerCallbackQuery(callbackQueryId, existingChat ? "Этот аккаунт не связан с данным чатом." : "Сессия не найдена. Выполните /start."); }
        if (!session.consentAcceptedAt || session.consentPrivacyVersion !== currentPrivacyVersion) return void await replyPort.answerCallbackQuery(callbackQueryId, "Сначала подтвердите согласие с политикой конфиденциальности.");
        const handled = await runCallbackAction({ chatId, userId, employeeId: session.employeeId, messageId, callbackQueryId, action: () => employeeClient(session.employeeId).submitFeedback({ threadId: session.threadId, targetMessageId: decoded.targetMessageId, rating: decoded.rating, source: "telegram" }) });
        if (handled.repeated) return;
        await replyPort.answerCallbackQuery(callbackQueryId, "Спасибо, учту 👍");
        if (messageId !== undefined) await removeReplyMarkup(chatId, messageId);
      } catch (error) {
        logShellError("callback", error); await replyPort.answerCallbackQuery(callbackQueryId, data.startsWith("tg:consent:") ? "Не удалось сохранить согласие. Попробуйте ещё раз позже." : data.startsWith("ob:") ? "Не удалось сохранить профиль. Попробуйте ещё раз позже." : "Не удалось сохранить отзыв. Попробуйте ещё раз позже.");
      } finally {
        const remaining = leaveChat(chatId);
        if (remaining === 0 && actionKey && callbackActionKeys.get(chatId) === actionKey) callbackActionKeys.delete(chatId);
      }
    },
  };
}
