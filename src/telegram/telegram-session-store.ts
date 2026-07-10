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
  consentAcceptedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type TelegramSessionClaimResult =
  | { status: "claimed"; session: TelegramSession }
  | { status: "chat_already_linked" }
  | { status: "employee_already_linked" };

export interface TelegramSessionStore {
  getByChatId(chatId: string): Promise<TelegramSession | undefined>;
  claim(session: TelegramSession): Promise<TelegramSessionClaimResult>;
  save(session: TelegramSession): Promise<void>;
}
