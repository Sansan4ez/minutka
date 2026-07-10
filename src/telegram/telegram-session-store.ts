export type TelegramIdentity = {
  chatId: string;
  userId?: string;
};

export type TelegramSession = {
  chatId: string;
  userId?: string;
  employeeId: string;
  threadId: string;
  inviteCode?: string;
  createdAt: string;
  updatedAt: string;
};

export interface TelegramSessionStore {
  getByChatId(chatId: string): Promise<TelegramSession | undefined>;
  save(session: TelegramSession): Promise<void>;
}
