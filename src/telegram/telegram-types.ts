export type TelegramInlineButton = {
  text: string;
  callbackData: string;
};

export type TelegramReplyMarkup = {
  inlineKeyboard: TelegramInlineButton[][];
};

export interface TelegramReplyPort {
  sendMessage(chatId: string, text: string, options?: { replyMarkup?: TelegramReplyMarkup }): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
}
