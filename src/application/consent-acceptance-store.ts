import type { AuditEventRecord } from "./audit-event-store.js";
import type { ClaimConsentResult } from "./profile-store.js";
import type { Consent } from "../domain/employee.js";
import type { TelegramIdentity } from "./telegram-invite-redemption-store.js";

/**
 * Coordinates the privacy-sensitive consent state change and its safe audit
 * record. Persistent implementations commit both or neither.
 */
export type ConsentAcceptanceStore = {
  accept(input: {
    consent: Consent;
    auditEvent: AuditEventRecord;
    /** Present only for Telegram; persistent implementations update this binding atomically. */
    telegramIdentity?: TelegramIdentity;
  }): Promise<ClaimConsentResult>;
};
