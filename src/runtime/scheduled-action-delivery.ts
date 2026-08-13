import type { AssistantChatResult } from "../application/assistant-service.js";
import type { PersonalAssistantService } from "../application/personal-assistant-service.js";
import type { ScheduledProcessRunner } from "../application/scheduler-service.js";
import type { createTelegramShell } from "../telegram/telegram-shell.js";
import { requireTelegramDeliverySession, type TelegramSessionStore } from "../telegram/telegram-session-store.js";

export function createTelegramScheduledActionRunner(input: {
  assistant: Pick<PersonalAssistantService, "runScheduledProcess">;
  telegramSessionStore: Pick<TelegramSessionStore, "getDeliveryByEmployee">;
  telegramShell?: Pick<ReturnType<typeof createTelegramShell>, "deliverProactive">;
}): ScheduledProcessRunner {
  return async (fire) => {
    if (!input.telegramShell) throw new TelegramDeliveryNotConfiguredError();
    const delivery = requireTelegramDeliverySession(await input.telegramSessionStore.getDeliveryByEmployee(fire.userId));
    const result = fire.kind === "reminder"
      ? scheduledReminderResult(fire.scheduleId, fire.scheduledFor, fire.text)
      : await input.assistant.runScheduledProcess({
        userId: fire.userId,
        threadId: delivery.threadId,
        processId: fire.processId,
      });
    await input.telegramShell.deliverProactive(delivery.chatId, result, fire.userId);
  };
}

function scheduledReminderResult(scheduleId: string, scheduledFor: string, text: string): AssistantChatResult {
  return {
    messageId: `reminder-${scheduleId}-${scheduledFor}`.replace(/[^A-Za-z0-9_.-]/gu, "_").slice(0, 50),
    response: text,
    selectedProcessIds: ["core"],
    outcome: { status: "completed" },
    effect: "none",
    pendingActions: [],
  };
}

class TelegramDeliveryNotConfiguredError extends Error {
  constructor() { super("Telegram delivery is not configured."); this.name = "TelegramDeliveryNotConfiguredError"; }
}
