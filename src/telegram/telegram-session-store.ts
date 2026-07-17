export type TelegramIdentity = { chatId: string; userId?: string };

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

export interface TelegramSessionStore {
  getByIdentity(identity: TelegramIdentity): Promise<TelegramSession | undefined>;
  claim(input: { identity: TelegramIdentity; session: TelegramSession }): Promise<TelegramSessionClaimResult>;
  /** Removes the chat-to-employee link during personal-data deletion. */
  deleteByEmployee(employeeId: string): Promise<void>;
  markConsentAccepted(input: {
    identity: TelegramIdentity;
    employeeId: string;
    acceptedAt: string;
  }): Promise<void>;
  /** Claims delivery of one onboarding confirmation draft atomically. */
  claimOnboardingConfirmationDelivery(input: {
    identity: TelegramIdentity;
    employeeId: string;
    deliveryKey: string;
  }): Promise<TelegramOnboardingConfirmationClaimResult>;
  /** Makes a failed delivery retryable without clearing a newer claim. */
  releaseOnboardingConfirmationDelivery(input: {
    identity: TelegramIdentity;
    employeeId: string;
    deliveryKey: string;
  }): Promise<void>;
  /** Claims one Telegram action message durably so stale keyboards stay idempotent after restarts. */
  claimActionMessage(input: {
    identity: TelegramIdentity;
    employeeId: string;
    messageId: number;
  }): Promise<{ status: "claimed" | "already_claimed" }>;
  /** Releases only the matching failed action so a retry can perform the side effect. */
  releaseActionMessage(input: {
    identity: TelegramIdentity;
    employeeId: string;
    messageId: number;
  }): Promise<void>;
}
