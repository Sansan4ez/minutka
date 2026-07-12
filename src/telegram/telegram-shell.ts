import type { MinutkaClient } from "../client/sdk/minutka-client.js";
import type { TelegramIdentity, TelegramSessionStore } from "./telegram-session-store.js";
import type { TelegramReplyPort } from "./telegram-types.js";
import { decodeFeedbackCallbackData, encodeFeedbackCallbackData } from "./callback-data.js";

export const maxTelegramMessageCharacters = 4_000;
export function splitTelegramMessage(text: string): string[] {
  const characters = Array.from(text); const chunks: string[] = [];
  for (let start = 0; start < characters.length; start += maxTelegramMessageCharacters) chunks.push(characters.slice(start, start + maxTelegramMessageCharacters).join(""));
  return chunks;
}
const onboardingFormat = "роль | задача 1; задача 2 | support|efficiency | beginner|intermediate|advanced";
function identity(chatId: string, userId?: string): TelegramIdentity { return { chatId, userId }; }
function parseOnboardingProfile(text: string): { role: string; typicalTasks: string[]; persona: "support" | "efficiency"; aiLevel: "beginner" | "intermediate" | "advanced" } | undefined {
  const [role, tasksInput, persona, aiLevel, ...extra] = text.split("|").map((part) => part.trim());
  const typicalTasks = tasksInput?.split(";").map((task) => task.trim()) ?? [];
  return extra.length === 0 && role && typicalTasks.length >= 1 && typicalTasks.length <= 7 && !typicalTasks.some((task) => !task) && (persona === "support" || persona === "efficiency") && (aiLevel === "beginner" || aiLevel === "intermediate" || aiLevel === "advanced") ? { role, typicalTasks, persona, aiLevel } : undefined;
}
function logShellError(operation: string, error: unknown): void { console.error(`Telegram shell ${operation} failed (${error instanceof Error ? error.name : "UnknownError"}).`); }
async function sendConsentPrompt(replyPort: TelegramReplyPort, chatId: string, employeeId: string, privacyExplanation: string) { await replyPort.sendMessage(chatId, privacyExplanation, { replyMarkup: { inlineKeyboard: [[{ text: "✅ Принимаю", callbackData: `tg:consent:${employeeId}` }]] } }); }

export function createTelegramShell(deps: { client: MinutkaClient; sessionStore: TelegramSessionStore; replyPort: TelegramReplyPort }) {
  const { client, sessionStore, replyPort } = deps; const inFlightChatIds = new Set<string>();
  return {
    async handleStart(chatId: string, inviteCode?: string, userId?: string) {
      try {
        if (!userId) return void await replyPort.sendMessage(chatId, "Не удалось определить аккаунт Telegram.");
        const telegramIdentity = identity(chatId, userId); const existing = await sessionStore.getByIdentity(telegramIdentity);
        if (existing) {
          if (inviteCode && inviteCode !== "") {
            // A persisted session intentionally has no raw invite. The in-memory
            // fixture keeps only this comparison behavior for existing MVP specs.
            if (existing.consentAcceptedAt) {
              const invite = await client.openInvite({ inviteCode }).catch(() => undefined);
              if (!invite || invite.employeeId !== existing.employeeId) return void await replyPort.sendMessage(chatId, "Этот чат уже привязан к другому пользователю. Смена привязки не поддерживается.");
            }
          }
          if (!existing.consentAcceptedAt) {
            await sendConsentPrompt(replyPort, chatId, existing.employeeId, "Минутка хранит только необходимый рабочий контекст."); return;
          }
          return void await replyPort.sendMessage(chatId, "Вы уже зарегистрированы. Вы можете общаться с ботом.");
        }
        if (!inviteCode) return void await replyPort.sendMessage(chatId, "Добро пожаловать! Для начала работы вам нужна индивидуальная ссылка с инвайт-кодом.");
        const inviteResult = await client.openInvite({ inviteCode }); const timestamp = new Date().toISOString();
        const claim = await sessionStore.claim({ identity: telegramIdentity, session: { employeeId: inviteResult.employeeId, threadId: inviteResult.employeeId, createdAt: timestamp, updatedAt: timestamp } });
        if (claim.status === "employee_already_linked") return void await replyPort.sendMessage(chatId, "Эта индивидуальная ссылка уже привязана к другому Telegram-аккаунту.");
        if (claim.status === "chat_already_linked") return void await replyPort.sendMessage(chatId, "Этот чат уже связан с профилем.");
        await sendConsentPrompt(replyPort, chatId, inviteResult.employeeId, inviteResult.privacyExplanation);
      } catch (error) { logShellError("/start", error); await replyPort.sendMessage(chatId, "Эта индивидуальная ссылка недействительна. Обратитесь за новой ссылкой."); }
    },
    async handleText(chatId: string, text: string, userId?: string) {
      const trimmed = text.trim(); if (!trimmed) return void await replyPort.sendMessage(chatId, "Сообщение не может быть пустым."); if (Array.from(trimmed).length > 4096) return void await replyPort.sendMessage(chatId, "Сообщение слишком длинное (максимум 4096 символов).");
      if (inFlightChatIds.has(chatId)) return void await replyPort.sendMessage(chatId, "Пожалуйста, подождите, я ещё отвечаю на предыдущее сообщение."); inFlightChatIds.add(chatId);
      try {
        const session = await sessionStore.getByIdentity(identity(chatId, userId));
        if (!session) {
          const existingChat = await sessionStore.getByIdentity(identity(chatId));
          return void await replyPort.sendMessage(chatId, existingChat ? "Этот аккаунт не связан с данным чатом." : "Откройте бота по индивидуальной ссылке /start <code>");
        }
        if (!session.consentAcceptedAt) return void await replyPort.sendMessage(chatId, "Сначала подтвердите согласие с политикой конфиденциальности.");
        try { await client.getProfile({ employeeId: session.employeeId }); } catch (error) {
          if (!(error instanceof Error && error.message === "profile not found")) throw error; const profile = parseOnboardingProfile(trimmed); if (!profile) return void await replyPort.sendMessage(chatId, `Чтобы завершить настройку, отправьте одну строку в формате:\n${onboardingFormat}`);
          const onboarding = await client.completeOnboarding({ employeeId: session.employeeId, ...profile }); for (const chunk of splitTelegramMessage(onboarding.firstResponse.trim())) await replyPort.sendMessage(chatId, chunk); return;
        }
        const chat = await client.chat({ employeeId: session.employeeId, threadId: session.threadId, text: trimmed }); const chunks = splitTelegramMessage(chat.response); if (!chat.response.trim()) throw new Error("Agent returned an empty response");
        const replyMarkup = { inlineKeyboard: [["positive", "neutral", "negative"].map((rating) => ({ text: rating === "positive" ? "👍" : rating === "neutral" ? "👌" : "👎", callbackData: encodeFeedbackCallbackData(rating as "positive" | "neutral" | "negative", chat.messageId) }))] };
        for (const [index, chunk] of chunks.entries()) await replyPort.sendMessage(chatId, chunk, index === chunks.length - 1 ? { replyMarkup } : undefined);
      } catch (error) { logShellError("text message", error); await replyPort.sendMessage(chatId, "Не удалось обработать сообщение. Попробуйте ещё раз позже."); } finally { inFlightChatIds.delete(chatId); }
    },
    async handleCallback(chatId: string, callbackQueryId: string, data: string, userId?: string) {
      try {
        const telegramIdentity = identity(chatId, userId); const session = await sessionStore.getByIdentity(telegramIdentity);
        if (data.startsWith("tg:consent:")) {
          const employeeId = data.slice("tg:consent:".length); if (!session || session.employeeId !== employeeId) return void await replyPort.answerCallbackQuery(callbackQueryId, "Неверная сессия.");
          const consent = await client.acceptConsent({ employeeId, accepted: true, source: "telegram" }); await sessionStore.markConsentAccepted({ identity: telegramIdentity, employeeId, acceptedAt: consent.acceptedAt }); await replyPort.answerCallbackQuery(callbackQueryId, "Согласие принято!"); await replyPort.sendMessage(chatId, `Спасибо! Теперь отправьте одну строку в формате:\n${onboardingFormat}`); return;
        }
        if (!data.startsWith("fb:")) return void await replyPort.answerCallbackQuery(callbackQueryId, "Неизвестное действие."); const decoded = decodeFeedbackCallbackData(data); if (!decoded) return void await replyPort.answerCallbackQuery(callbackQueryId, "Неверный формат отзыва.");
        if (!session) { const existingChat = await sessionStore.getByIdentity(identity(chatId)); return void await replyPort.answerCallbackQuery(callbackQueryId, existingChat ? "Этот аккаунт не связан с данным чатом." : "Сессия не найдена. Выполните /start."); }
        if (!session.consentAcceptedAt) return void await replyPort.answerCallbackQuery(callbackQueryId, "Сначала подтвердите согласие с политикой конфиденциальности.");
        await client.submitFeedback({ employeeId: session.employeeId, threadId: session.threadId, targetMessageId: decoded.targetMessageId, rating: decoded.rating, source: "telegram" }); await replyPort.answerCallbackQuery(callbackQueryId, "Спасибо, учту 👍");
      } catch (error) { logShellError("callback", error); await replyPort.answerCallbackQuery(callbackQueryId, "Не удалось сохранить отзыв. Попробуйте ещё раз позже."); }
    },
  };
}
