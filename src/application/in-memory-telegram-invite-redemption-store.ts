import type { AuditEventStore } from "./audit-event-store.js";
import type { ProfileStore } from "./profile-store.js";
import type {
  TelegramInviteRedemptionResult,
  TelegramInviteRedemptionStore,
} from "./telegram-invite-redemption-store.js";
import type { TelegramSessionStore } from "../telegram/telegram-session-store.js";

const redemptionLocks = new WeakMap<AuditEventStore, Map<string, Promise<void>>>();

/** Executable-spec counterpart of the PostgreSQL redemption transaction. */
export function createInMemoryTelegramInviteRedemptionStore(input: {
  profileStore: ProfileStore;
  sessionStore: TelegramSessionStore;
  auditEventStore: AuditEventStore;
}): TelegramInviteRedemptionStore {
  const locks = redemptionLocks.get(input.auditEventStore) ?? new Map<string, Promise<void>>();
  redemptionLocks.set(input.auditEventStore, locks);
  return {
    redeem: (request) => withKeyLock(locks, request.inviteCode, async () => {
      // Claim the session before changing invite state, matching the order in
      // the PostgreSQL transaction. A conflicting claim therefore leaves the
      // invite available instead of consuming it without a session.
      const participant = await input.profileStore.getParticipantByInviteCode(request.inviteCode);
      if (!participant) return { status: "invite_not_found" };
      const claimed = await input.sessionStore.claim({
        identity: request.identity,
        session: {
          employeeId: participant.employeeId,
          threadId: participant.employeeId,
          createdAt: request.occurredAt,
          updatedAt: request.occurredAt,
        },
      });
      if (claimed.status !== "claimed") return claimed;
      await input.profileStore.openInvite({
        inviteCode: request.inviteCode,
        openedAt: request.occurredAt,
      });
      await input.auditEventStore.append({ ...request.auditEvent, employeeId: participant.employeeId });
      return { status: "claimed", employeeId: claimed.session.employeeId, threadId: claimed.session.threadId };
    }),
  };
}

async function withKeyLock<T>(locks: Map<string, Promise<void>>, key: string, action: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  locks.set(key, queued);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (locks.get(key) === queued) locks.delete(key);
  }
}
