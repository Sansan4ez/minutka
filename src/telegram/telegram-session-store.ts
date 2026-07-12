export type TelegramIdentity = { chatId: string; userId?: string };

/** Raw transport identifiers are accepted only at this private boundary. */
export type TelegramSession = {
  employeeId: string;
  threadId: string;
  consentAcceptedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type TelegramSessionClaimResult =
  | { status: "claimed"; session: TelegramSession }
  | { status: "chat_already_linked" }
  | { status: "employee_already_linked" };

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
}
