import type { ServiceMinutkaClient } from "../client/sdk/minutka-client.js";
import { MinutkaApiError } from "../client/sdk/http-transport.js";
import type { OnboardingProgressResult } from "../client/sdk/minutka-client.js";
import type { TelegramIdentity, TelegramSessionStore } from "./telegram-session-store.js";
import type { TelegramReplyPort } from "./telegram-types.js";
import { decodeFeedbackCallbackData, encodeFeedbackCallbackData } from "./callback-data.js";
import { privacyExplanation } from "../domain/privacy.js";
import { PersistenceError } from "../application/persistence-error.js";

export const maxTelegramMessageCharacters = 4_000;
export function splitTelegramMessage(text: string): string[] {
  const characters = Array.from(text); const chunks: string[] = [];
  for (let start = 0; start < characters.length; start += maxTelegramMessageCharacters) chunks.push(characters.slice(start, start + maxTelegramMessageCharacters).join(""));
  return chunks;
}
const typingRefreshMilliseconds = 4_000;
const maxTelegramCallbackDataBytes = 64;
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

export function createTelegramShell(deps: { client: ServiceMinutkaClient; sessionStore: TelegramSessionStore; replyPort: TelegramReplyPort }) {
  const { client, sessionStore, replyPort } = deps; const inFlightChatIds = new Set<string>(); const employeeClient = (employeeId: string) => client.forEmployee(employeeId);
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
      try {
        const session = await sessionStore.getByIdentity(identity(chatId, userId));
        if (!session) { const existingChat = await sessionStore.getByIdentity(identity(chatId)); return void await replyPort.sendMessage(chatId, existingChat ? "Этот аккаунт не связан с данным чатом." : "Откройте бота по индивидуальной ссылке /start <code>"); }
        if (!session.consentAcceptedAt) return void await replyPort.sendMessage(chatId, "Сначала подтвердите согласие с политикой конфиденциальности.");
        let profileExists = true;
        try { await employeeClient(session.employeeId).getProfile(); } catch (error) { if ((error instanceof PersistenceError || error instanceof MinutkaApiError) && error.code === "profile_not_found") profileExists = false; else throw error; }
        if (!profileExists) return renderOnboardingProgress(replyPort, chatId, await employeeClient(session.employeeId).submitOnboardingAnswer({ text: trimmed }));
        const chat = await withTypingIndicator(replyPort, chatId, () => employeeClient(session.employeeId).chat({ threadId: session.threadId, text: trimmed }));
        const chunks = splitTelegramMessage(chat.response); if (!chat.response.trim()) throw new Error("Agent returned an empty response");
        const replyMarkup = { inlineKeyboard: [["positive", "neutral", "negative"].map((rating) => ({ text: rating === "positive" ? "👍" : rating === "neutral" ? "👌" : "👎", callbackData: encodeFeedbackCallbackData(rating as "positive" | "neutral" | "negative", chat.messageId) }))] };
        for (const [index, chunk] of chunks.entries()) await replyPort.sendMessage(chatId, chunk, index === chunks.length - 1 ? { replyMarkup } : undefined);
      } catch (error) { logShellError("text message", error); await replyPort.sendMessage(chatId, "Не удалось обработать сообщение. Попробуйте ещё раз позже."); } finally { inFlightChatIds.delete(chatId); }
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
