import { PersistenceError } from "../application/persistence-error.js";
import { currentPrivacyVersion } from "../domain/privacy.js";
import type { TelegramIdentity, TelegramSession, TelegramSessionClaimResult, TelegramSessionStore } from "./telegram-session-store.js";

/** Executable-spec session adapter; persistent runtime uses PostgreSQL digests. */
export function createInMemoryTelegramSessionStore(): TelegramSessionStore {
  const store = new Map<string, { identity: TelegramIdentity; session: TelegramSession; onboardingConfirmationDeliveryKey?: string; handledActionMessageIds: Set<number> }>();
  return {
    async getByIdentity(identity) {
      const found = store.get(identity.chatId);
      if (!found || (identity.userId !== undefined && found.identity.userId !== identity.userId)) return undefined;
      return { ...found.session };
    },
    async claim({ identity, session }): Promise<TelegramSessionClaimResult> {
      if (store.has(identity.chatId)) return { status: "chat_already_linked" };
      if ([...store.values()].some((entry) => entry.session.employeeId === session.employeeId)) return { status: "employee_already_linked" };
      store.set(identity.chatId, { identity: { ...identity }, session: { ...session }, handledActionMessageIds: new Set() });
      return { status: "claimed", session: { ...session } };
    },
    async deleteByEmployee(employeeId) {
      for (const [chatId, entry] of store) {
        if (entry.session.employeeId === employeeId) store.delete(chatId);
      }
    },
    async markConsentAccepted({ identity, employeeId, acceptedAt }) {
      const found = store.get(identity.chatId);
      if (!found || found.identity.userId !== identity.userId || found.session.employeeId !== employeeId) {
        throw new PersistenceError("session_not_found");
      }
      found.session = { ...found.session, consentAcceptedAt: acceptedAt, consentPrivacyVersion: currentPrivacyVersion, updatedAt: acceptedAt };
    },
    async claimOnboardingConfirmationDelivery({ identity, employeeId, deliveryKey }) {
      const found = store.get(identity.chatId);
      if (!found || found.identity.userId !== identity.userId || found.session.employeeId !== employeeId) {
        throw new PersistenceError("session_not_found");
      }
      if (found.onboardingConfirmationDeliveryKey === deliveryKey) return { status: "already_claimed" };
      found.onboardingConfirmationDeliveryKey = deliveryKey;
      return { status: "claimed" };
    },
    async releaseOnboardingConfirmationDelivery({ identity, employeeId, deliveryKey }) {
      const found = store.get(identity.chatId);
      if (!found || found.identity.userId !== identity.userId || found.session.employeeId !== employeeId) {
        throw new PersistenceError("session_not_found");
      }
      if (found.onboardingConfirmationDeliveryKey === deliveryKey) found.onboardingConfirmationDeliveryKey = undefined;
    },
    async claimActionMessage({ identity, employeeId, messageId }) {
      const found = store.get(identity.chatId);
      if (!found || found.identity.userId !== identity.userId || found.session.employeeId !== employeeId) {
        throw new PersistenceError("session_not_found");
      }
      if (found.handledActionMessageIds.has(messageId)) return { status: "already_claimed" };
      found.handledActionMessageIds.add(messageId);
      return { status: "claimed" };
    },
    async releaseActionMessage({ identity, employeeId, messageId }) {
      const found = store.get(identity.chatId);
      if (!found || found.identity.userId !== identity.userId || found.session.employeeId !== employeeId) {
        throw new PersistenceError("session_not_found");
      }
      found.handledActionMessageIds.delete(messageId);
    },
  };
}
