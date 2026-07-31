import type { Telegraf } from "telegraf";
import { maxTelegramMessageCharacters, telegramMessageLength } from "./telegram-message-limits.js";
import type { TelegramReplyPort } from "./telegram-types.js";

type TelegramApi = Telegraf["telegram"];

export function createTelegrafReplyPort(getTelegram: () => TelegramApi | undefined): TelegramReplyPort {
  const telegram = (): TelegramApi => {
    const active = getTelegram();
    if (!active) throw new Error("Bot not running");
    return active;
  };

  return {
    async sendMessage(chatId, text, options) {
      if (telegramMessageLength(text) > maxTelegramMessageCharacters) throw new Error("Telegram message exceeds the 4000 UTF-16-unit limit");
      const sent = await telegram().sendMessage(chatId, text, {
        ...(options?.parseMode === undefined ? {} : { parse_mode: options.parseMode }),
        ...(options?.replyToMessageId === undefined ? {} : { reply_parameters: { message_id: options.replyToMessageId } }),
        reply_markup: options?.replyMarkup ? { inline_keyboard: options.replyMarkup.inlineKeyboard.map((row) => row.map((button) => ({ text: button.text, callback_data: button.callbackData }))) } : undefined,
      });
      return { messageId: sent.message_id };
    },
    async editReplyMarkup(chatId, messageId, replyMarkup) {
      await telegram().editMessageReplyMarkup(chatId, messageId, undefined, replyMarkup ? { inline_keyboard: replyMarkup.inlineKeyboard.map((row) => row.map((button) => ({ text: button.text, callback_data: button.callbackData }))) } : { inline_keyboard: [] });
    },
    async sendChatAction(chatId, action) { await telegram().sendChatAction(chatId, action); },
    async answerCallbackQuery(id, text) { await telegram().answerCbQuery(id, text?.slice(0, 200)); },
  };
}
