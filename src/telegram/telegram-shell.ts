import type { MinutkaClient } from "../client/sdk/minutka-client.js";
import type { TelegramSessionStore } from "./telegram-session-store.js";
import type { TelegramReplyPort } from "./telegram-types.js";
import { decodeFeedbackCallbackData } from "./callback-data.js";

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
        const existingSession = await sessionStore.getByChatId(chatId);
        if (existingSession) {
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

        // Deep link onboarding
        const inviteResult = await client.openInvite({ inviteCode });
        await sessionStore.save({
          chatId,
          userId,
          employeeId: inviteResult.employeeId,
          threadId: inviteResult.employeeId,
          inviteCode,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });

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
        const msg = error instanceof Error ? error.message : String(error);
        await replyPort.sendMessage(chatId, `Ошибка при обработке команды /start: ${msg}`);
      }
    },

    async handleText(chatId: string, text: string, userId?: string): Promise<void> {
      const trimmed = text.trim();
      if (!trimmed) {
        await replyPort.sendMessage(chatId, "Сообщение не может быть пустым.");
        return;
      }
      if (trimmed.length > 4096) {
        await replyPort.sendMessage(chatId, "Сообщение слишком длинное (максимум 4096 символов).");
        return;
      }

      if (inFlightChatIds.has(chatId)) {
        await replyPort.sendMessage(chatId, "Пожалуйста, подождите, я ещё отвечаю на предыдущее сообщение.");
        return;
      }

      const session = await sessionStore.getByChatId(chatId);
      if (!session) {
        await replyPort.sendMessage(chatId, "Откройте бота по индивидуальной ссылке /start <code>");
        return;
      }

      try {
        // Verify profile exists
        try {
          await client.getProfile({ employeeId: session.employeeId });
        } catch (err) {
          await replyPort.sendMessage(
            chatId,
            "Сначала завершите onboarding/профиль по индивидуальной ссылке или через CLI/API"
          );
          return;
        }

        inFlightChatIds.add(chatId);

        const chatResult = await client.chat({
          employeeId: session.employeeId,
          threadId: session.threadId,
          text: trimmed,
        });

        // Send response with 👍 👌 👎 buttons
        await replyPort.sendMessage(chatId, chatResult.response, {
          replyMarkup: {
            inlineKeyboard: [
              [
                { text: "👍", callbackData: `fb:p:${chatResult.messageId}` },
                { text: "👌", callbackData: `fb:n:${chatResult.messageId}` },
                { text: "👎", callbackData: `fb:d:${chatResult.messageId}` },
              ],
            ],
          },
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        await replyPort.sendMessage(chatId, `Ошибка при обработке запроса: ${msg}`);
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
          if (!session || session.employeeId !== employeeId) {
            await replyPort.answerCallbackQuery(callbackQueryId, "Неверная сессия.");
            return;
          }

          await client.acceptConsent({
            employeeId,
            accepted: true,
            source: "telegram",
          });

          await replyPort.answerCallbackQuery(callbackQueryId, "Согласие принято!");
          await replyPort.sendMessage(
            chatId,
            "Спасибо! Ваше согласие с политикой конфиденциальности зарегистрировано. Пожалуйста, завершите настройку профиля через CLI или API (укажите роль и задачи), после чего вы сможете общаться с ботом."
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
        const msg = error instanceof Error ? error.message : String(error);
        await replyPort.answerCallbackQuery(callbackQueryId, `Ошибка: ${msg}`);
      }
    },
  };
}
