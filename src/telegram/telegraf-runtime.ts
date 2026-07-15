import { Telegraf } from "telegraf";
import type { createTelegramShell } from "./telegram-shell.js";

export function createTelegrafBot(deps: {
  token: string;
  shell: ReturnType<typeof createTelegramShell>;
}): Telegraf {
  const { token, shell } = deps;
  const bot = new Telegraf(token);

  bot.catch((error) => {
    // Telegraf errors may embed an entire update/request payload, including
    // chat identifiers and message text. Keep the operational signal only.
    console.error(`Telegraf update handling failed (${error instanceof Error ? error.name : "UnknownError"}).`);
  });

  bot.start(async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("Для защиты конфиденциальности бот работает только в личном чате.");
      return;
    }

    const chatId = String(ctx.chat.id);
    const userId = ctx.from ? String(ctx.from.id) : undefined;
    const text = ctx.message.text || "";
    const parts = text.split(/\s+/);
    const inviteCode = parts[1] || undefined;

    await shell.handleStart(chatId, inviteCode, userId);
  });

  bot.on("text", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("Для защиты конфиденциальности бот работает только в личном чате.");
      return;
    }

    const chatId = String(ctx.chat.id);
    const userId = ctx.from ? String(ctx.from.id) : undefined;
    const text = ctx.message.text;

    await shell.handleText(chatId, text, userId);
  });

  bot.on("photo", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("Для защиты конфиденциальности бот работает только в личном чате.");
      return;
    }
    const photo = ctx.message.photo.at(-1);
    if (!photo) return;
    await shell.handlePhoto(String(ctx.chat.id), { fileId: photo.file_id, ...(ctx.message.caption ? { caption: ctx.message.caption } : {}) }, ctx.from ? String(ctx.from.id) : undefined);
  });

  bot.on("voice", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("Для защиты конфиденциальности бот работает только в личном чате.");
      return;
    }

    const voice = ctx.message.voice;
    await shell.handleVoice(String(ctx.chat.id), {
      fileId: voice.file_id,
      messageId: ctx.message.message_id,
      durationSeconds: voice.duration,
      ...(voice.file_size === undefined ? {} : { fileSizeBytes: voice.file_size }),
    }, ctx.from ? String(ctx.from.id) : undefined);
  });

  bot.on("callback_query", async (ctx) => {
    if (ctx.chat && ctx.chat.type !== "private") {
      await ctx.answerCbQuery("Для защиты конфиденциальности бот работает только в личном чате.");
      return;
    }

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
