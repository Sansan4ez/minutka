export type TelegramInlineButton = {
  text: string;
  callbackData: string;
};

export type TelegramReplyMarkup = {
  inlineKeyboard: TelegramInlineButton[][];
};

export interface TelegramReplyPort {
  /** `replyToMessageId` is transient Telegram UI metadata; it is never persisted. */
  sendMessage(chatId: string, text: string, options?: { replyMarkup?: TelegramReplyMarkup; replyToMessageId?: number }): Promise<void>;
  /** Ephemeral Telegram UI signal; it is never persisted as application data. */
  sendChatAction(chatId: string, action: "typing"): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
}
