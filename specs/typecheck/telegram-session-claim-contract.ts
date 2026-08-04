import type { TelegramSessionStore } from "../../src/telegram/telegram-session-store.js";

declare const store: TelegramSessionStore;

void store.claim({
  identity: { chatId: "chat", userId: "user" },
  session: {
    employeeId: "owner",
    threadId: "thread",
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    // @ts-expect-error Consent can only be persisted through markConsentAccepted.
    consentAcceptedAt: "2026-07-12T00:00:00.000Z",
  },
});
