import type { AssistantService } from "../application/assistant-service.js";
import type { IngestionService } from "../application/ingestion-service.js";
import type { ServiceMinutkaClient } from "../client/sdk/minutka-client.js";
import { MinutkaApiError } from "../client/sdk/http-transport.js";
import type { OnboardingProgressResult } from "../client/sdk/minutka-client.js";
import type { TelegramIdentity, TelegramSessionStore } from "./telegram-session-store.js";
import type { TelegramReplyPort } from "./telegram-types.js";
import { decodeFeedbackCallbackData, encodeFeedbackCallbackData } from "./callback-data.js";
import { privacyExplanation } from "../domain/privacy.js";
import { PersistenceError } from "../application/persistence-error.js";
import { voiceProcessingTimeoutMs as defaultVoiceProcessingTimeoutMs, type SpeechToTextPort } from "../application/speech-to-text.js";
import type { TelegramVoiceFileGateway } from "./telegram-voice-file-gateway.js";
import { photoDownloadTimeoutMs, PhotoDownloadTimeoutError, PhotoFileTooLargeError, UnsupportedPhotoContentTypeError, type TelegramPhotoFileGateway } from "./telegram-photo-file-gateway.js";
import { pipeline, Transform } from "node:stream";

export const maxTelegramMessageCharacters = 4_000;
export function splitTelegramMessage(text: string): string[] {
  const characters = Array.from(text); const chunks: string[] = [];
  for (let start = 0; start < characters.length; start += maxTelegramMessageCharacters) chunks.push(characters.slice(start, start + maxTelegramMessageCharacters).join(""));
  return chunks;
}
const typingRefreshMilliseconds = 4_000;
const maxTelegramCallbackDataBytes = 64;
export const maxVoiceDurationSeconds = 300;
export const maxVoiceFileSizeBytes = 20 * 1024 * 1024;
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
const onboardingIntroduction = "Расскажите немного о работе в удобной форме: ваша роль, типичные задачи, предпочитаемый стиль общения — «Поддержка» или «Эффективность» — и опыт работы с ИИ. Можно ответить одним сообщением или по частям.";
function identity(chatId: string, userId?: string): TelegramIdentity { return { chatId, userId }; }
function logShellError(operation: string, error: unknown): void { console.error(`Telegram shell ${operation} failed (${error instanceof Error ? error.name : "UnknownError"}).`); }
function consentCallbackData(employeeId: string): string | undefined { const callbackData = `tg:consent:${employeeId}`; return Buffer.byteLength(callbackData, "utf8") <= maxTelegramCallbackDataBytes ? callbackData : undefined; }
function onboardingCallbackData(action: "confirm" | "reset" | "persona" | "aiLevel", value?: string): string | undefined {
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
function onboardingChoiceValue(field: "persona" | "aiLevel", choice: string): string {
  const values = field === "persona"
    ? { "Поддержка": "support", "Эффективность": "efficiency" }
    : { "Начинающий": "beginner", "Средний": "intermediate", "Продвинутый": "advanced" };
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
async function renderOnboardingProgress(replyPort: TelegramReplyPort, chatId: string, progress: OnboardingProgressResult): Promise<void> {
  if (progress.status === "needs_answer") return replyPort.sendMessage(chatId, progress.prompt);
  if (progress.status === "needs_choice") {
    const choices = progress.choices.map((choice) => ({ text: choice, callbackData: onboardingCallbackData(progress.field, onboardingChoiceValue(progress.field, choice)) })).filter((choice): choice is { text: string; callbackData: string } => Boolean(choice.callbackData));
    return replyPort.sendMessage(chatId, progress.prompt, { replyMarkup: { inlineKeyboard: choices.map((choice) => [choice]) } });
  }
  if (progress.status === "needs_correction") return replyPort.sendMessage(chatId, progress.prompt);
  if (progress.status === "needs_confirmation") {
    const summary = progress.summary;
    return replyPort.sendMessage(chatId, ["Проверьте, пожалуйста:", `- роль: ${summary.role};`, `- типичные задачи: ${summary.typicalTasks.join(", ")};`, `- стиль: ${summary.persona};`, `- опыт работы с ИИ: ${summary.aiLevel}.`, "", "Всё верно?"].join("\n"), { replyMarkup: { inlineKeyboard: [[{ text: "✅ Подтвердить", callbackData: onboardingCallbackData("confirm")! }, { text: "✏️ Исправить", callbackData: onboardingCallbackData("reset")! }]] } });
  }
  const response = progress.result.firstResponse.trim();
  if (!response) throw new Error("Agent returned an empty onboarding response");
  for (const chunk of splitTelegramMessage(response)) await replyPort.sendMessage(chatId, chunk);
}

export function createTelegramShell(deps: { client: ServiceMinutkaClient; sessionStore: TelegramSessionStore; replyPort: TelegramReplyPort; assistant?: Pick<AssistantService, "chat">; ingestion?: Pick<IngestionService, "captureInboxFile">; photoFileGateway?: TelegramPhotoFileGateway; speechToText?: SpeechToTextPort; voiceFileGateway?: TelegramVoiceFileGateway; voiceProcessingTimeoutMs?: number; photoProcessingTimeoutMs?: number }) {
  const { client, sessionStore, replyPort, assistant, ingestion, photoFileGateway, speechToText, voiceFileGateway } = deps; const voiceTimeoutMs = deps.voiceProcessingTimeoutMs ?? defaultVoiceProcessingTimeoutMs; const photoTimeoutMs = deps.photoProcessingTimeoutMs ?? photoDownloadTimeoutMs; const inFlightChatIds = new Set<string>(); const processedPhotoMediaGroups = new Map<string, string>(); const employeeClient = (employeeId: string) => client.forEmployee(employeeId);
  async function authorizedSession(chatId: string, userId?: string) {
    const session = await sessionStore.getByIdentity(identity(chatId, userId));
    if (!session) {
      const existingChat = await sessionStore.getByIdentity(identity(chatId));
      await replyPort.sendMessage(chatId, existingChat ? "Этот аккаунт не связан с данным чатом." : "Откройте бота по индивидуальной ссылке /start <code>");
      return undefined;
    }
    if (!session.consentAcceptedAt) {
      await replyPort.sendMessage(chatId, "Сначала подтвердите согласие с политикой конфиденциальности.");
      return undefined;
    }
    return session;
  }
  async function dispatchText(chatId: string, text: string, session: { employeeId: string; threadId: string }, inputModality: "text" | "voice", source: { kind: "text"; text: string } | { kind: "blob"; blobKey: string } = { kind: "text", text }) {
    let profileExists = true;
    try { await employeeClient(session.employeeId).getProfile(); } catch (error) { if ((error instanceof PersistenceError || error instanceof MinutkaApiError) && error.code === "profile_not_found") profileExists = false; else throw error; }
    if (!profileExists) return renderOnboardingProgress(replyPort, chatId, await employeeClient(session.employeeId).submitOnboardingAnswer({ text }));
    const chat = assistant
      ? await withTypingIndicator(replyPort, chatId, () => assistant.chat({ userId: session.employeeId, threadId: session.threadId, text, source, inputModality }))
      : await withTypingIndicator(replyPort, chatId, () => employeeClient(session.employeeId).chat({ threadId: session.threadId, text, inputModality }));
    const chunks = splitTelegramMessage(chat.response); if (!chat.response.trim()) throw new Error("Agent returned an empty response");
    const replyMarkup = { inlineKeyboard: [["positive", "neutral", "negative"].map((rating) => ({ text: rating === "positive" ? "👍" : rating === "neutral" ? "👌" : "👎", callbackData: encodeFeedbackCallbackData(rating as "positive" | "neutral" | "negative", chat.messageId) }))] };
    for (const [index, chunk] of chunks.entries()) await replyPort.sendMessage(chatId, chunk, index === chunks.length - 1 ? { replyMarkup } : undefined);
  }
  return {
    async handleStart(chatId: string, inviteCode?: string, userId?: string) {
      try {
        if (!userId) return void await replyPort.sendMessage(chatId, "Не удалось определить аккаунт Telegram.");
        const telegramIdentity = identity(chatId, userId); const existing = await sessionStore.getByIdentity(telegramIdentity);
        if (existing) {
          if (!existing.consentAcceptedAt) { await sendConsentPrompt(replyPort, chatId, existing.employeeId, privacyExplanation); await employeeClient(existing.employeeId).recordPrivacyExplanationShown(); return; }
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
      const trimmed = text.trim(); if (!trimmed) return void await replyPort.sendMessage(chatId, "Сообщение не может быть пустым."); if (Array.from(trimmed).length > 4096) return void await replyPort.sendMessage(chatId, "Сообщение слишком длинное (максимум 4096 символов).");
      if (inFlightChatIds.has(chatId)) return void await replyPort.sendMessage(chatId, "Пожалуйста, подождите, я ещё отвечаю на предыдущее сообщение."); inFlightChatIds.add(chatId);
      try { const session = await authorizedSession(chatId, userId); if (!session) return; await dispatchText(chatId, trimmed, session, "text"); }
      catch (error) { logShellError("text message", error); await replyPort.sendMessage(chatId, "Не удалось обработать сообщение. Попробуйте ещё раз позже."); } finally { inFlightChatIds.delete(chatId); }
    },
    async handlePhoto(chatId: string, photo: { fileId: string; caption?: string; mediaGroupId?: string }, userId?: string) {
      const mediaGroupKey = photo.mediaGroupId ? `${chatId}\u0000${photo.mediaGroupId}` : undefined;
      if (mediaGroupKey && processedPhotoMediaGroups.has(mediaGroupKey)) return;
      if (inFlightChatIds.has(chatId)) return void await replyPort.sendMessage(chatId, "Пожалуйста, подождите, я ещё отвечаю на предыдущее сообщение."); inFlightChatIds.add(chatId);
      try {
        const session = await authorizedSession(chatId, userId); if (!session) return;
        if (!assistant || !ingestion || !photoFileGateway) return void await replyPort.sendMessage(chatId, "Фотографии сейчас недоступны. Пожалуйста, отправьте описание текстом.");
        if (mediaGroupKey) {
          const timer = setTimeout(() => processedPhotoMediaGroups.delete(mediaGroupKey), 60_000);
          timer.unref();
          processedPhotoMediaGroups.set(mediaGroupKey, photo.fileId);
        }
        await withVoiceTimeout(photoTimeoutMs, async () => {
          const file = await photoFileGateway.downloadPhoto(photo.fileId);
          const blob = await ingestion.captureInboxFile({ userId: session.employeeId, fileName: file.fileName, body: file.body, contentType: file.contentType });
          const text = photo.caption?.trim() || "Фото без подписи";
          await dispatchText(chatId, text, session, "text", { kind: "blob", blobKey: blob.key });
        }).catch((error) => { if (error instanceof VoiceProcessingTimeoutError) throw new PhotoDownloadTimeoutError(); throw error; });
      } catch (error) {
        if (mediaGroupKey) processedPhotoMediaGroups.delete(mediaGroupKey);
        logShellError("photo message", error);
        const message = error instanceof PhotoFileTooLargeError ? "Фотография слишком большая (максимум 10 МБ)."
          : error instanceof UnsupportedPhotoContentTypeError ? "Поддерживаются только фотографии JPEG и PNG."
          : error instanceof PhotoDownloadTimeoutError ? "Не удалось загрузить фотографию вовремя. Попробуйте ещё раз позже."
          : "Не удалось обработать фотографию. Попробуйте ещё раз позже.";
        await replyPort.sendMessage(chatId, message);
      } finally { inFlightChatIds.delete(chatId); }
    },
    async handleVoice(chatId: string, voice: { fileId: string; messageId: number; durationSeconds: number; fileSizeBytes?: number }, userId?: string) {
      if (inFlightChatIds.has(chatId)) return void await replyPort.sendMessage(chatId, "Пожалуйста, подождите, я ещё отвечаю на предыдущее сообщение."); inFlightChatIds.add(chatId);
      try {
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
          await dispatchText(chatId, transcript, session, "voice");
        } finally {
          // A provider can fail before consuming the download; close it promptly.
          if (audio) destroyStream(audio);
          if (audio && audio !== file?.stream) destroyStream(file!.stream);
        }
      } catch (error) { logShellError("voice message", error); await replyPort.sendMessage(chatId, error instanceof VoiceFileTooLargeError ? "Голосовое сообщение слишком большое (максимум 20 МБ)." : "Не удалось обработать голосовое сообщение. Попробуйте ещё раз позже."); } finally { inFlightChatIds.delete(chatId); }
    },
    async handleCallback(chatId: string, callbackQueryId: string, data: string, userId?: string) {
      try {
        const telegramIdentity = identity(chatId, userId); const session = await sessionStore.getByIdentity(telegramIdentity);
        if (data.startsWith("tg:consent:")) {
          const employeeId = data.slice("tg:consent:".length); if (!session || session.employeeId !== employeeId) return void await replyPort.answerCallbackQuery(callbackQueryId, "Неверная сессия.");
          await employeeClient(employeeId).acceptConsent({ accepted: true, source: "telegram", telegramIdentity }); await replyPort.answerCallbackQuery(callbackQueryId, "Согласие принято!");
          try { await replyPort.sendMessage(chatId, onboardingIntroduction); } catch (error) { logShellError("consent follow-up delivery", error); }
          return;
        }
        if (data.startsWith("ob:")) {
          if (!session) return void await replyPort.answerCallbackQuery(callbackQueryId, "Сессия не найдена. Выполните /start.");
          if (!session.consentAcceptedAt) return void await replyPort.answerCallbackQuery(callbackQueryId, "Сначала подтвердите согласие с политикой конфиденциальности.");
          const [prefix, action, value, ...extra] = data.split(":");
          if (prefix !== "ob" || extra.length || !action) return void await replyPort.answerCallbackQuery(callbackQueryId, "Неизвестное действие.");
          if (action === "confirm" && !value) { const result = await withTypingIndicator(replyPort, chatId, () => employeeClient(session.employeeId).confirmOnboarding()); await replyPort.answerCallbackQuery(callbackQueryId, "Профиль сохранён!"); for (const chunk of splitTelegramMessage(result.firstResponse)) await replyPort.sendMessage(chatId, chunk); return; }
          if (action === "reset" && !value) { const progress = await employeeClient(session.employeeId).submitOnboardingAnswer({ text: "Исправить" }); await replyPort.answerCallbackQuery(callbackQueryId, "Что нужно исправить?"); return renderOnboardingProgress(replyPort, chatId, progress); }
          if ((action === "persona" || action === "aiLevel") && value) { await replyPort.answerCallbackQuery(callbackQueryId); return renderOnboardingProgress(replyPort, chatId, await employeeClient(session.employeeId).submitOnboardingAnswer({ text: value })); }
          return void await replyPort.answerCallbackQuery(callbackQueryId, "Неизвестное действие.");
        }
        if (!data.startsWith("fb:")) return void await replyPort.answerCallbackQuery(callbackQueryId, "Неизвестное действие."); const decoded = decodeFeedbackCallbackData(data); if (!decoded) return void await replyPort.answerCallbackQuery(callbackQueryId, "Неверный формат отзыва.");
        if (!session) { const existingChat = await sessionStore.getByIdentity(identity(chatId)); return void await replyPort.answerCallbackQuery(callbackQueryId, existingChat ? "Этот аккаунт не связан с данным чатом." : "Сессия не найдена. Выполните /start."); }
        if (!session.consentAcceptedAt) return void await replyPort.answerCallbackQuery(callbackQueryId, "Сначала подтвердите согласие с политикой конфиденциальности.");
        await employeeClient(session.employeeId).submitFeedback({ threadId: session.threadId, targetMessageId: decoded.targetMessageId, rating: decoded.rating, source: "telegram" }); await replyPort.answerCallbackQuery(callbackQueryId, "Спасибо, учту 👍");
      } catch (error) {
        logShellError("callback", error); await replyPort.answerCallbackQuery(callbackQueryId, data.startsWith("tg:consent:") ? "Не удалось сохранить согласие. Попробуйте ещё раз позже." : data.startsWith("ob:") ? "Не удалось сохранить профиль. Попробуйте ещё раз позже." : "Не удалось сохранить отзыв. Попробуйте ещё раз позже.");
      }
    },
  };
}
