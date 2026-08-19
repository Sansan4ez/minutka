import type { PersonalAssistantService } from "../application/personal-assistant-service.js";
import type { EngagementReminderDelivery } from "../application/engagement-reminder-sweep.js";
import type { ScheduledProcessRunner } from "../application/scheduler-service.js";
import type { createTelegramShell } from "../telegram/telegram-shell.js";
import { requireTelegramDeliverySession, type TelegramSessionStore } from "../telegram/telegram-session-store.js";

export function createTelegramScheduledActionRunner(input: {
  assistant: Pick<PersonalAssistantService, "runScheduledProcess">;
  telegramSessionStore: Pick<TelegramSessionStore, "getDeliveryByEmployee">;
  telegramShell?: Pick<ReturnType<typeof createTelegramShell>, "deliverProactive" | "deliverReminder">;
}): ScheduledProcessRunner {
  return async (fire) => {
    if (!input.telegramShell) throw new TelegramDeliveryNotConfiguredError();
    const delivery = requireTelegramDeliverySession(await input.telegramSessionStore.getDeliveryByEmployee(fire.userId));
    if (fire.kind === "reminder") {
      await input.telegramShell.deliverReminder(delivery.chatId, fire.text, fire.userId);
      return;
    }
    const result = await input.assistant.runScheduledProcess({
      userId: fire.userId,
      threadId: delivery.threadId,
      processId: fire.processId,
    });
    await input.telegramShell.deliverProactive(delivery.chatId, result, fire.userId);
  };
}

/**
 * Sends the automatic participation reminder over the same proactive delivery
 * path as the scheduled morning and evening touches. It opens no conversation
 * turn, so the reminder cannot record a touch or move the participation label.
 */
export function createTelegramEngagementReminderDelivery(input: {
  telegramSessionStore: Pick<TelegramSessionStore, "getDeliveryByEmployee">;
  telegramShell: Pick<ReturnType<typeof createTelegramShell>, "deliverReminder">;
}): EngagementReminderDelivery {
  return async ({ employeeId, text }) => {
    const delivery = await input.telegramSessionStore.getDeliveryByEmployee(employeeId);
    if (!delivery) return "delivery_session_missing";
    await input.telegramShell.deliverReminder(delivery.chatId, text, employeeId);
    return "delivered";
  };
}

class TelegramDeliveryNotConfiguredError extends Error {
  constructor() { super("Telegram delivery is not configured."); this.name = "TelegramDeliveryNotConfiguredError"; }
}
