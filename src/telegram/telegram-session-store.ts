export type TelegramIdentity = { chatId: string; userId?: string };

export const telegramActionMessageClaimLeaseMilliseconds = 60_000;
export const telegramActionMessageRetentionMilliseconds = 30 * 24 * 60 * 60 * 1_000;

/** Raw transport identifiers are accepted only at this private boundary. */
export type TelegramSession = {
  employeeId: string;
  threadId: string;
  consentAcceptedAt?: string;
  consentPrivacyVersion?: string;
  createdAt: string;
  updatedAt: string;
};

export type TelegramSessionClaimResult =
  | { status: "claimed"; session: TelegramSession }
  | { status: "chat_already_linked" }
  | { status: "employee_already_linked" };

export type TelegramOnboardingConfirmationClaimResult =
  | { status: "claimed" }
  | { status: "already_claimed" };

export type TelegramDeliverySession = TelegramSession & { chatId: string };

export interface TelegramSessionStore {
  getByIdentity(identity: TelegramIdentity): Promise<TelegramSession | undefined>;
  /** Private outbound-delivery lookup. Raw chat id never crosses the application facade. */
  getDeliveryByEmployee(employeeId: string): Promise<TelegramDeliverySession | undefined>;
  claim(input: { identity: TelegramIdentity; session: TelegramSession }): Promise<TelegramSessionClaimResult>;
  /** Removes the chat-to-employee link during personal-data deletion. */
  deleteByEmployee(employeeId: string): Promise<void>;
  markConsentAccepted(input: {
    identity: TelegramIdentity;
    employeeId: string;
    acceptedAt: string;
  }): Promise<void>;
  /** Claims delivery of one onboarding confirmation draft atomically. Stale claims are recoverable after the supplied instant. */
  claimOnboardingConfirmationDelivery(input: {
    identity: TelegramIdentity;
    employeeId: string;
    deliveryKey: string;
    claimedAt: string;
    staleBefore: string;
  }): Promise<TelegramOnboardingConfirmationClaimResult>;
  /** Commits only the matching successful delivery claim. */
  completeOnboardingConfirmationDelivery(input: {
    identity: TelegramIdentity;
    employeeId: string;
    deliveryKey: string;
    claimedAt: string;
  }): Promise<void>;
  /** Makes a failed delivery retryable without clearing a newer claim. */
  releaseOnboardingConfirmationDelivery(input: {
    identity: TelegramIdentity;
    employeeId: string;
    deliveryKey: string;
    claimedAt: string;
  }): Promise<void>;
  /** Claims one Telegram action message atomically. Completed actions stay idempotent; stale in-progress claims are recoverable. */
  claimActionMessage(input: {
    identity: TelegramIdentity;
    employeeId: string;
    messageId: number;
    claimedAt: string;
    staleBefore: string;
  }): Promise<{ status: "claimed" | "already_claimed" }>;
  /** Commits only the matching successful action claim. */
  completeActionMessage(input: {
    identity: TelegramIdentity;
    employeeId: string;
    messageId: number;
    claimedAt: string;
  }): Promise<void>;
  /** Releases only the matching failed action so a retry can perform the side effect. */
  releaseActionMessage(input: {
    identity: TelegramIdentity;
    employeeId: string;
    messageId: number;
    claimedAt: string;
  }): Promise<void>;
  /**
   * Deletes action deduplication rows older than the retention boundary.
   * Retention must remain longer than the claim lease. Once swept, pressing an
   * ancient inline keyboard may execute its idempotent action again.
   */
  purgeActionMessages(input: { claimedBefore: string }): Promise<number>;
}
