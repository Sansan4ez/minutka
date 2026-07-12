import type { TelegramIdentity, TelegramSession, TelegramSessionClaimResult, TelegramSessionStore } from "./telegram-session-store.js";

/** Executable-spec session adapter; persistent runtime uses PostgreSQL digests. */
export function createInMemoryTelegramSessionStore(): TelegramSessionStore {
  const store = new Map<string, { identity: TelegramIdentity; session: TelegramSession }>();
  return {
    async getByIdentity(identity) {
      const found = store.get(identity.chatId);
      if (!found || (identity.userId !== undefined && found.identity.userId !== identity.userId)) return undefined;
      return { ...found.session };
    },
    async claim({ identity, session }): Promise<TelegramSessionClaimResult> {
      if (store.has(identity.chatId)) return { status: "chat_already_linked" };
      if ([...store.values()].some((entry) => entry.session.employeeId === session.employeeId)) return { status: "employee_already_linked" };
      store.set(identity.chatId, { identity: { ...identity }, session: { ...session } });
      return { status: "claimed", session: { ...session } };
    },
    async markConsentAccepted({ identity, employeeId, acceptedAt }) {
      const found = store.get(identity.chatId);
      if (!found || found.identity.userId !== identity.userId || found.session.employeeId !== employeeId) throw new Error("telegram session not found");
      found.session = { ...found.session, consentAcceptedAt: acceptedAt, updatedAt: acceptedAt };
    },
  };
}
