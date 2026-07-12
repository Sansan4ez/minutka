import type { AuditEventStore } from "./audit-event-store.js";
import type { ProfileStore } from "./profile-store.js";
import type {
  TelegramInviteRedemptionResult,
  TelegramInviteRedemptionStore,
} from "./telegram-invite-redemption-store.js";
import type { TelegramSessionStore } from "../telegram/telegram-session-store.js";

/** Executable-spec counterpart of the PostgreSQL redemption transaction. */
export function createInMemoryTelegramInviteRedemptionStore(input: {
  profileStore: ProfileStore;
  sessionStore: TelegramSessionStore;
  auditEventStore: AuditEventStore;
}): TelegramInviteRedemptionStore {
  return {
    async redeem({ inviteCode, identity, occurredAt, auditEvent }): Promise<TelegramInviteRedemptionResult> {
      const opened = await input.profileStore.openInvite({
        inviteCode,
        openedAt: occurredAt,
      });
      if (!opened) return { status: "invite_not_found" };

      const claimed = await input.sessionStore.claim({
        identity,
        session: {
          employeeId: opened.participant.employeeId,
          threadId: opened.participant.employeeId,
          createdAt: occurredAt,
          updatedAt: occurredAt,
        },
      });
      if (claimed.status !== "claimed") return claimed;
      await input.auditEventStore.append({
        ...auditEvent,
        employeeId: opened.participant.employeeId,
      });
      return {
        status: "claimed",
        employeeId: claimed.session.employeeId,
        threadId: claimed.session.threadId,
      };
    },
  };
}
