import type {
  TelegramSession,
  TelegramSessionClaimResult,
  TelegramSessionStore,
} from "./telegram-session-store.js";

export function createInMemoryTelegramSessionStore(): TelegramSessionStore {
  const store = new Map<string, TelegramSession>();

  return {
    async getByChatId(chatId: string): Promise<TelegramSession | undefined> {
      const session = store.get(chatId);
      return session ? { ...session } : undefined;
    },
    async claim(session: TelegramSession): Promise<TelegramSessionClaimResult> {
      if (store.has(session.chatId)) {
        return { status: "chat_already_linked" };
      }
      if ([...store.values()].some((existing) => existing.employeeId === session.employeeId)) {
        return { status: "employee_already_linked" };
      }

      const saved = { ...session };
      store.set(saved.chatId, saved);
      return { status: "claimed", session: { ...saved } };
    },
    async save(session: TelegramSession): Promise<void> {
      store.set(session.chatId, { ...session });
    },
  };
}
