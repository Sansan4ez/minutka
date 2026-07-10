import { Telegraf } from "telegraf";
import type { createTelegramShell } from "./telegram-shell.js";

export function createTelegrafBot(deps: {
  token: string;
  shell: ReturnType<typeof createTelegramShell>;
}): Telegraf {
  const { token, shell } = deps;
  const bot = new Telegraf(token);

  bot.catch((err, ctx) => {
    console.error(`Telegraf error for update ${ctx.update.update_id}:`, err);
  });

  bot.start(async (ctx) => {
    const chatId = String(ctx.chat.id);
    const userId = ctx.from ? String(ctx.from.id) : undefined;
    const text = ctx.message.text || "";
    const parts = text.split(/\s+/);
    const inviteCode = parts[1] || undefined;

    await shell.handleStart(chatId, inviteCode, userId);
  });

  bot.on("text", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const userId = ctx.from ? String(ctx.from.id) : undefined;
    const text = ctx.message.text;

    await shell.handleText(chatId, text, userId);
  });

  bot.on("callback_query", async (ctx) => {
    const chatId = ctx.chat ? String(ctx.chat.id) : "";
    const userId = ctx.from ? String(ctx.from.id) : undefined;
    const callbackQueryId = ctx.callbackQuery.id;
    const data = ("data" in ctx.callbackQuery) ? ctx.callbackQuery.data : "";

    let finalChatId = chatId;
    if (!finalChatId && ctx.callbackQuery.message) {
      finalChatId = String(ctx.callbackQuery.message.chat.id);
    }

    await shell.handleCallback(finalChatId, callbackQueryId, data || "", userId);
  });

  return bot;
}
