import type { PersonalAssistantService } from "../application/personal-assistant-service.js";
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

class TelegramDeliveryNotConfiguredError extends Error {
  constructor() { super("Telegram delivery is not configured."); this.name = "TelegramDeliveryNotConfiguredError"; }
}
