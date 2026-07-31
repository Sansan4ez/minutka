export type TelegramInlineButton = {
  text: string;
  callbackData: string;
};

export type TelegramReplyMarkup = {
  inlineKeyboard: TelegramInlineButton[][];
};

export type TelegramSentMessage = { messageId: number };
export type TelegramParseMode = "HTML";

export interface TelegramReplyPort {
  /** Telegram message ids are transient UI metadata; they are never persisted. */
  sendMessage(chatId: string, text: string, options?: { parseMode?: TelegramParseMode; replyMarkup?: TelegramReplyMarkup; replyToMessageId?: number }): Promise<TelegramSentMessage>;
  /** Removes or replaces transient inline controls without changing message text. */
  editReplyMarkup(chatId: string, messageId: number, replyMarkup?: TelegramReplyMarkup): Promise<void>;
  /** Ephemeral Telegram UI signal; it is never persisted as application data. */
  sendChatAction(chatId: string, action: "typing"): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
}
