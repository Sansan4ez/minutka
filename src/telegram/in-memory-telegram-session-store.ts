import type { TelegramSession, TelegramSessionStore } from "./telegram-session-store.js";

export function createInMemoryTelegramSessionStore(): TelegramSessionStore {
  const store = new Map<string, TelegramSession>();

  return {
    async getByChatId(chatId: string): Promise<TelegramSession | undefined> {
      return store.get(chatId);
    },
    async save(session: TelegramSession): Promise<void> {
      store.set(session.chatId, { ...session });
    },
  };
}
