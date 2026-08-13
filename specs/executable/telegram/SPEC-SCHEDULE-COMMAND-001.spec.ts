import { describe, expect, it } from "vitest";
import { ServiceMinutkaClient } from "../../../src/client/sdk/minutka-client.js";
import { createInMemoryTelegramSessionStore } from "../../../src/telegram/in-memory-telegram-session-store.js";
import { createTelegramShell } from "../../../src/telegram/telegram-shell.js";
import { executableSpecPrivacyExplanation } from "../../../src/runtime/create-in-memory-runtime.js";

const linkedAt = "2026-07-30T05:00:00.000Z";

async function setup(schedulesByOwner: Record<string, unknown[]>) {
  const sessionStore = createInMemoryTelegramSessionStore();
  for (const [index, owner] of Object.keys(schedulesByOwner).entries()) {
    const identity = { chatId: `chat-${index}`, userId: `telegram-${index}` };
    await sessionStore.claim({
      identity,
      session: { employeeId: owner, threadId: `thread-${owner}`, createdAt: linkedAt, updatedAt: linkedAt },
    });
    await sessionStore.markConsentAccepted({ identity, employeeId: owner, acceptedAt: linkedAt });
  }
  const messages: Array<{ chatId: string; text: string; parseMode?: string }> = [];
  const client = new ServiceMinutkaClient({
    async redeemTelegramInvite() { throw new Error("not used"); },
    forEmployee(employeeId: string) {
      return {
        async listSchedules() { return { schedules: schedulesByOwner[employeeId] ?? [] }; },
      } as never;
    },
  });
  const shell = createTelegramShell({
    client, sessionStore, privacyExplanation: executableSpecPrivacyExplanation,
    replyPort: {
      async sendMessage(chatId, text, options) { messages.push({ chatId, text, parseMode: options?.parseMode }); return { messageId: messages.length }; },
      async editReplyMarkup() {}, async sendChatAction() {}, async answerCallbackQuery() {},
    },
  });
  return { shell, messages };
}

describe("SPEC-SCHEDULE-COMMAND-001: deterministic Telegram /schedule", () => {
  it("shows only the authenticated owner's schedules through safe HTML rendering", async () => {
    const { shell, messages } = await setup({
      ownerA: [{ id: "ownerA:day_focus-daily", processId: "day_focus", timeOfDay: "08:30", timezone: "Europe/Moscow", enabled: true, nextFireAt: "2026-07-30T05:30:00.000Z" }],
      ownerB: [{ id: "ownerB:evening_reflection-daily", processId: "evening_reflection", timeOfDay: "20:00", timezone: "Asia/Tokyo", enabled: true, nextFireAt: "2026-07-30T11:00:00.000Z" }],
    });

    await shell.handleSchedule("chat-0", "telegram-0");

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ chatId: "chat-0", parseMode: "HTML" });
    expect(messages[0]!.text).toContain("Утренний фокус — 08:30 (Europe/Moscow)");
    expect(messages[0]!.text).toContain("следующее срабатывание: 30.07 08:30 (Europe/Moscow)");
    expect(messages[0]!.text).not.toContain("2026-07-30T05:30:00.000Z");
    expect(messages[0]!.text).not.toContain("Вечерняя рефлексия");
    expect(messages[0]!.text).not.toContain("ownerA");
  });

  it("shows a deterministic empty state for an owner without schedules", async () => {
    const { shell, messages } = await setup({ ownerA: [] });

    await shell.handleSchedule("chat-0", "telegram-0");

    expect(messages).toEqual([{ chatId: "chat-0", text: "У вас пока нет расписаний.", parseMode: "HTML" }]);
  });
});
