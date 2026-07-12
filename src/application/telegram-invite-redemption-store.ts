import type { AuditEventRecord } from "./audit-event-store.js";

/** Transport identity is accepted only by this private application boundary. */
export type TelegramIdentity = {
  chatId: string;
  userId?: string;
};

export type TelegramInviteRedemptionResult =
  | { status: "claimed"; employeeId: string; threadId: string }
  | { status: "invite_not_found" }
  | { status: "chat_already_linked" }
  | { status: "employee_already_linked" };

/**
 * Atomically redeems a pre-issued invite for one Telegram identity. Production
 * implementations must commit the invite transition, session claim and audit
 * event in one database transaction.
 */
export type TelegramInviteRedemptionStore = {
  redeem(input: {
    inviteCode: string;
    identity: TelegramIdentity;
    occurredAt: string;
    auditEvent: AuditEventRecord;
  }): Promise<TelegramInviteRedemptionResult>;
};
