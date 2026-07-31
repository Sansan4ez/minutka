import { PersistenceError } from "../application/persistence-error.js";
import { currentPrivacyVersion } from "../domain/privacy.js";
import type { TelegramIdentity, TelegramSession, TelegramSessionClaimResult, TelegramSessionStore } from "./telegram-session-store.js";

/** Executable-spec session adapter; persistent runtime uses PostgreSQL digests. */
export function createInMemoryTelegramSessionStore(): TelegramSessionStore {
  const store = new Map<string, { identity: TelegramIdentity; session: TelegramSession; onboardingConfirmationDeliveryKey?: string; onboardingConfirmationClaim?: { deliveryKey: string; claimedAt: string }; actionMessages: Map<number, { claimedAt: string; completed: boolean }> }>();
  return {
    async getByIdentity(identity) {
      const found = store.get(identity.chatId);
      if (!found || (identity.userId !== undefined && found.identity.userId !== identity.userId)) return undefined;
      return { ...found.session };
    },
    async getDeliveryByEmployee(employeeId) {
      const found = [...store.entries()].find(([, entry]) => entry.session.employeeId === employeeId);
      return found ? { chatId: found[0], ...found[1].session } : undefined;
    },
    async claim({ identity, session }): Promise<TelegramSessionClaimResult> {
      if (store.has(identity.chatId)) return { status: "chat_already_linked" };
      if ([...store.values()].some((entry) => entry.session.employeeId === session.employeeId)) return { status: "employee_already_linked" };
      store.set(identity.chatId, { identity: { ...identity }, session: { ...session }, actionMessages: new Map() });
      return { status: "claimed", session: { ...session } };
    },
    async rotateThread({ userId, nextThreadId, updatedAt }) {
      const found = [...store.values()].find((entry) => entry.session.employeeId === userId);
      if (!found) throw new PersistenceError("session_not_found");
      found.session = { ...found.session, threadId: nextThreadId, updatedAt };
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
    async claimOnboardingConfirmationDelivery({ identity, employeeId, deliveryKey, claimedAt, staleBefore }) {
      const found = store.get(identity.chatId);
      if (!found || found.identity.userId !== identity.userId || found.session.employeeId !== employeeId) {
        throw new PersistenceError("session_not_found");
      }
      if (found.onboardingConfirmationDeliveryKey === deliveryKey) return { status: "already_claimed" };
      if (found.onboardingConfirmationClaim && found.onboardingConfirmationClaim.claimedAt >= staleBefore) return { status: "already_claimed" };
      found.onboardingConfirmationClaim = { deliveryKey, claimedAt };
      return { status: "claimed" };
    },
    async completeOnboardingConfirmationDelivery({ identity, employeeId, deliveryKey, claimedAt }) {
      const found = store.get(identity.chatId);
      if (!found || found.identity.userId !== identity.userId || found.session.employeeId !== employeeId) {
        throw new PersistenceError("session_not_found");
      }
      if (found.onboardingConfirmationClaim?.deliveryKey === deliveryKey && found.onboardingConfirmationClaim.claimedAt === claimedAt) {
        found.onboardingConfirmationDeliveryKey = deliveryKey;
        found.onboardingConfirmationClaim = undefined;
      }
    },
    async releaseOnboardingConfirmationDelivery({ identity, employeeId, deliveryKey, claimedAt }) {
      const found = store.get(identity.chatId);
      if (!found || found.identity.userId !== identity.userId || found.session.employeeId !== employeeId) {
        throw new PersistenceError("session_not_found");
      }
      if (found.onboardingConfirmationClaim?.deliveryKey === deliveryKey && found.onboardingConfirmationClaim.claimedAt === claimedAt) found.onboardingConfirmationClaim = undefined;
    },
    async claimActionMessage({ identity, employeeId, messageId, claimedAt, staleBefore }) {
      const found = store.get(identity.chatId);
      if (!found || found.identity.userId !== identity.userId || found.session.employeeId !== employeeId) {
        throw new PersistenceError("session_not_found");
      }
      const existing = found.actionMessages.get(messageId);
      if (existing?.completed || (existing && existing.claimedAt >= staleBefore)) return { status: "already_claimed" };
      found.actionMessages.set(messageId, { claimedAt, completed: false });
      return { status: "claimed" };
    },
    async completeActionMessage({ identity, employeeId, messageId, claimedAt }) {
      const found = store.get(identity.chatId);
      if (!found || found.identity.userId !== identity.userId || found.session.employeeId !== employeeId) {
        throw new PersistenceError("session_not_found");
      }
      const existing = found.actionMessages.get(messageId);
      if (existing?.claimedAt === claimedAt && !existing.completed) found.actionMessages.set(messageId, { claimedAt, completed: true });
    },
    async releaseActionMessage({ identity, employeeId, messageId, claimedAt }) {
      const found = store.get(identity.chatId);
      if (!found || found.identity.userId !== identity.userId || found.session.employeeId !== employeeId) {
        throw new PersistenceError("session_not_found");
      }
      const existing = found.actionMessages.get(messageId);
      if (existing?.claimedAt === claimedAt && !existing.completed) found.actionMessages.delete(messageId);
    },
    async purgeActionMessages({ claimedBefore }) {
      let deleted = 0;
      for (const entry of store.values()) {
        for (const [messageId, action] of entry.actionMessages) {
          if (action.claimedAt < claimedBefore) {
            entry.actionMessages.delete(messageId);
            deleted += 1;
          }
        }
      }
      return deleted;
    },
  };
}
