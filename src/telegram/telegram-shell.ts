import type { MinutkaClient } from "../client/sdk/minutka-client.js";
import type { TelegramSession, TelegramSessionStore } from "./telegram-session-store.js";
import type { TelegramReplyPort } from "./telegram-types.js";
import {
  decodeFeedbackCallbackData,
  encodeFeedbackCallbackData,
} from "./callback-data.js";

export const maxTelegramMessageCharacters = 4_000;

export function splitTelegramMessage(text: string): string[] {
  const characters = Array.from(text);
  const chunks: string[] = [];

  for (let start = 0; start < characters.length; start += maxTelegramMessageCharacters) {
    chunks.push(characters.slice(start, start + maxTelegramMessageCharacters).join(""));
  }

  return chunks;
}

function isSessionOwner(session: TelegramSession, userId?: string): boolean {
  return userId !== undefined && userId === session.userId;
}

const onboardingFormat =
  "роль | задача 1; задача 2 | support|efficiency | beginner|intermediate|advanced";

function parseOnboardingProfile(text: string):
  | {
      role: string;
      typicalTasks: string[];
      persona: "support" | "efficiency";
      aiLevel: "beginner" | "intermediate" | "advanced";
    }
  | undefined {
  const [role, tasksInput, persona, aiLevel, ...extra] = text
    .split("|")
    .map((part) => part.trim());
  const typicalTasks = tasksInput?.split(";").map((task) => task.trim()) ?? [];

  if (
    extra.length > 0 ||
    !role ||
    typicalTasks.length < 1 ||
    typicalTasks.length > 7 ||
    typicalTasks.some((task) => !task) ||
    (persona !== "support" && persona !== "efficiency") ||
    (aiLevel !== "beginner" && aiLevel !== "intermediate" && aiLevel !== "advanced")
  ) {
    return undefined;
  }

  return { role, typicalTasks, persona, aiLevel };
}

function isProfileNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message === "profile not found";
}

function logShellError(operation: string, error: unknown): void {
  const kind = error instanceof Error ? error.name : "UnknownError";
  console.error(`Telegram shell ${operation} failed (${kind}).`);
}

export function createTelegramShell(deps: {
  client: MinutkaClient;
  sessionStore: TelegramSessionStore;
  replyPort: TelegramReplyPort;
}) {
  const { client, sessionStore, replyPort } = deps;
  const inFlightChatIds = new Set<string>();

  return {
    async handleStart(chatId: string, inviteCode?: string, userId?: string): Promise<void> {
      try {
        if (!userId) {
          await replyPort.sendMessage(chatId, "Не удалось определить аккаунт Telegram.");
          return;
        }

        const existingSession = await sessionStore.getByChatId(chatId);
        if (existingSession) {
          if (!isSessionOwner(existingSession, userId)) {
            await replyPort.sendMessage(chatId, "Этот аккаунт не связан с данным чатом.");
            return;
          }

          if (inviteCode) {
            if (inviteCode === existingSession.inviteCode) {
              await replyPort.sendMessage(chatId, "Вы уже зарегистрированы и этот чат связан с вашим профилем.");
              return;
            } else {
              await replyPort.sendMessage(chatId, "Этот чат уже привязан к другому пользователю. Смена привязки не поддерживается.");
              return;
            }
          }
          await replyPort.sendMessage(chatId, "Вы уже зарегистрированы. Вы можете общаться с ботом.");
          return;
        }

        if (!inviteCode) {
          await replyPort.sendMessage(
            chatId,
            "Добро пожаловать! Для начала работы вам нужна индивидуальная ссылка с инвайт-кодом."
          );
          return;
        }

        // A bearer invite may be claimed by only one Telegram identity in this MVP.
        // The store owns this check so a future persistent implementation can make it atomic.
        const inviteResult = await client.openInvite({ inviteCode });
        const timestamp = new Date().toISOString();
        const claim = await sessionStore.claim({
          chatId,
          userId,
          employeeId: inviteResult.employeeId,
          threadId: inviteResult.employeeId,
          inviteCode,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        if (claim.status === "employee_already_linked") {
          await replyPort.sendMessage(
            chatId,
            "Эта индивидуальная ссылка уже привязана к другому Telegram-аккаунту.",
          );
          return;
        }
        if (claim.status === "chat_already_linked") {
          await replyPort.sendMessage(chatId, "Этот чат уже связан с профилем.");
          return;
        }

        await replyPort.sendMessage(chatId, inviteResult.privacyExplanation, {
          replyMarkup: {
            inlineKeyboard: [
              [
                {
                  text: "✅ Принимаю",
                  callbackData: `tg:consent:${inviteResult.employeeId}`,
                },
              ],
            ],
          },
        });
      } catch (error) {
        logShellError("/start", error);
        await replyPort.sendMessage(
          chatId,
          "Не удалось обработать команду /start. Попробуйте ещё раз позже.",
        );
      }
    },

    async handleText(chatId: string, text: string, userId?: string): Promise<void> {
      const trimmed = text.trim();
      if (!trimmed) {
        await replyPort.sendMessage(chatId, "Сообщение не может быть пустым.");
        return;
      }
      if (Array.from(trimmed).length > 4096) {
        await replyPort.sendMessage(chatId, "Сообщение слишком длинное (максимум 4096 символов).");
        return;
      }

      if (inFlightChatIds.has(chatId)) {
        await replyPort.sendMessage(chatId, "Пожалуйста, подождите, я ещё отвечаю на предыдущее сообщение.");
        return;
      }
      // Claim the per-chat slot before any await so concurrently delivered updates
      // cannot both pass the guard while session/profile lookups are pending.
      inFlightChatIds.add(chatId);

      try {
        const session = await sessionStore.getByChatId(chatId);
        if (!session) {
          await replyPort.sendMessage(chatId, "Откройте бота по индивидуальной ссылке /start <code>");
          return;
        }
        if (!isSessionOwner(session, userId)) {
          await replyPort.sendMessage(chatId, "Этот аккаунт не связан с данным чатом.");
          return;
        }

        // A completed profile means this is an ordinary chat message.
        try {
          await client.getProfile({ employeeId: session.employeeId });
        } catch (error) {
          if (!isProfileNotFoundError(error)) throw error;
          if (!session.consentAcceptedAt) {
            await replyPort.sendMessage(chatId, "Сначала подтвердите согласие с политикой конфиденциальности.");
            return;
          }

          const profile = parseOnboardingProfile(trimmed);
          if (!profile) {
            await replyPort.sendMessage(
              chatId,
              `Чтобы завершить настройку, отправьте одну строку в формате:\n${onboardingFormat}`,
            );
            return;
          }

          const onboarding = await client.completeOnboarding({
            employeeId: session.employeeId,
            ...profile,
          });
          const firstResponse = onboarding.firstResponse.trim();
          if (!firstResponse) throw new Error("Agent returned an empty onboarding response");
          for (const chunk of splitTelegramMessage(firstResponse)) {
            await replyPort.sendMessage(chatId, chunk);
          }
          return;
        }

        const chatResult = await client.chat({
          employeeId: session.employeeId,
          threadId: session.threadId,
          text: trimmed,
        });

        const responseChunks = splitTelegramMessage(chatResult.response);
        if (responseChunks.length === 0 || !chatResult.response.trim()) {
          throw new Error("Agent returned an empty response");
        }

        const replyMarkup = {
          inlineKeyboard: [
            [
              {
                text: "👍",
                callbackData: encodeFeedbackCallbackData("positive", chatResult.messageId),
              },
              {
                text: "👌",
                callbackData: encodeFeedbackCallbackData("neutral", chatResult.messageId),
              },
              {
                text: "👎",
                callbackData: encodeFeedbackCallbackData("negative", chatResult.messageId),
              },
            ],
          ],
        };
        for (const [index, chunk] of responseChunks.entries()) {
          await replyPort.sendMessage(
            chatId,
            chunk,
            index === responseChunks.length - 1 ? { replyMarkup } : undefined,
          );
        }
      } catch (error) {
        logShellError("text message", error);
        await replyPort.sendMessage(
          chatId,
          "Не удалось обработать сообщение. Попробуйте ещё раз позже.",
        );
      } finally {
        inFlightChatIds.delete(chatId);
      }
    },

    async handleCallback(
      chatId: string,
      callbackQueryId: string,
      data: string,
      userId?: string
    ): Promise<void> {
      try {
        if (data.startsWith("tg:consent:")) {
          const employeeId = data.substring("tg:consent:".length);
          const session = await sessionStore.getByChatId(chatId);
          if (!session || !isSessionOwner(session, userId) || session.employeeId !== employeeId) {
            await replyPort.answerCallbackQuery(callbackQueryId, "Неверная сессия.");
            return;
          }

          const consent = await client.acceptConsent({
            employeeId,
            accepted: true,
            source: "telegram",
          });
          await sessionStore.save({
            ...session,
            consentAcceptedAt: consent.acceptedAt,
            updatedAt: new Date().toISOString(),
          });

          await replyPort.answerCallbackQuery(callbackQueryId, "Согласие принято!");
          await replyPort.sendMessage(
            chatId,
            `Спасибо! Теперь отправьте одну строку в формате:\n${onboardingFormat}`,
          );
          return;
        }

        if (data.startsWith("fb:")) {
          const decoded = decodeFeedbackCallbackData(data);
          if (!decoded) {
            await replyPort.answerCallbackQuery(callbackQueryId, "Неверный формат отзыва.");
            return;
          }

          const session = await sessionStore.getByChatId(chatId);
          if (!session) {
            await replyPort.answerCallbackQuery(callbackQueryId, "Сессия не найдена. Выполните /start.");
            return;
          }
          if (!isSessionOwner(session, userId)) {
            await replyPort.answerCallbackQuery(callbackQueryId, "Этот аккаунт не связан с данным чатом.");
            return;
          }

          await client.submitFeedback({
            employeeId: session.employeeId,
            threadId: session.threadId,
            targetMessageId: decoded.targetMessageId,
            rating: decoded.rating,
            source: "telegram",
          });

          await replyPort.answerCallbackQuery(callbackQueryId, "Спасибо, учту 👍");
          return;
        }

        // Unknown prefix
        await replyPort.answerCallbackQuery(callbackQueryId, "Неизвестное действие.");
      } catch (error) {
        logShellError("callback", error);
        await replyPort.answerCallbackQuery(
          callbackQueryId,
          "Не удалось сохранить отзыв. Попробуйте ещё раз позже.",
        );
      }
    },
  };
}
