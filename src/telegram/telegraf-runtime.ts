import { Telegraf } from "telegraf";
import type { createTelegramShell, TelegramFileAttachment } from "./telegram-shell.js";

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

  const privateChat = async (ctx: { chat?: { type: string }; reply(text: string): Promise<unknown> }): Promise<boolean> => {
    if (ctx.chat?.type === "private") return true;
    await ctx.reply("Для защиты конфиденциальности бот работает только в личном чате.");
    return false;
  };
  const forwarded = (message: object): boolean => "forward_origin" in message || "forward_date" in message;
  const handleFile = async (ctx: any, attachment: TelegramFileAttachment): Promise<void> => {
    if (!await privateChat(ctx)) return;
    await shell.handleFile(String(ctx.chat.id), attachment, ctx.from ? String(ctx.from.id) : undefined);
  };

  bot.start(async (ctx) => {
    if (!await privateChat(ctx)) return;
    const text = ctx.message.text || "";
    await shell.handleStart(String(ctx.chat.id), text.split(/\s+/)[1] || undefined, ctx.from ? String(ctx.from.id) : undefined);
  });

  bot.command("new", async (ctx) => {
    if (!await privateChat(ctx)) return;
    await shell.handleNew(String(ctx.chat.id), ctx.from ? String(ctx.from.id) : undefined);
  });

  bot.on("text", async (ctx) => {
    if (!await privateChat(ctx)) return;
    await shell.handleText(String(ctx.chat.id), ctx.message.text, ctx.from ? String(ctx.from.id) : undefined);
  });

  bot.on("photo", async (ctx) => {
    const photo = ctx.message.photo.at(-1);
    if (!photo) return;
    await handleFile(ctx, {
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id,
      messageId: ctx.message.message_id,
      payloadKind: "photo",
      fileName: `telegram-photo-${photo.file_unique_id}.jpg`,
      declaredMediaType: "image/jpeg",
      ...(ctx.message.caption ? { caption: ctx.message.caption } : {}),
      ...(ctx.message.media_group_id ? { mediaGroupId: ctx.message.media_group_id } : {}),
      ...(photo.file_size === undefined ? {} : { fileSizeBytes: photo.file_size }),
      forwarded: forwarded(ctx.message),
    });
  });

  bot.on("document", async (ctx) => {
    const file = ctx.message.document;
    await handleFile(ctx, {
      fileId: file.file_id, fileUniqueId: file.file_unique_id, messageId: ctx.message.message_id, payloadKind: "document",
      fileName: file.file_name || `telegram-document-${file.file_unique_id}`,
      ...(file.mime_type ? { declaredMediaType: file.mime_type } : {}),
      ...(ctx.message.caption ? { caption: ctx.message.caption } : {}),
      ...(ctx.message.media_group_id ? { mediaGroupId: ctx.message.media_group_id } : {}),
      ...(file.file_size === undefined ? {} : { fileSizeBytes: file.file_size }), forwarded: forwarded(ctx.message),
    });
  });

  bot.on("audio", async (ctx) => {
    const file = ctx.message.audio;
    await handleFile(ctx, {
      fileId: file.file_id, fileUniqueId: file.file_unique_id, messageId: ctx.message.message_id, payloadKind: "audio",
      fileName: file.file_name || `telegram-audio-${file.file_unique_id}`,
      ...(file.mime_type ? { declaredMediaType: file.mime_type } : {}),
      ...(ctx.message.caption ? { caption: ctx.message.caption } : {}),
      ...(ctx.message.media_group_id ? { mediaGroupId: ctx.message.media_group_id } : {}),
      ...(file.file_size === undefined ? {} : { fileSizeBytes: file.file_size }), forwarded: forwarded(ctx.message),
    });
  });

  bot.on("video", async (ctx) => {
    const file = ctx.message.video;
    await handleFile(ctx, {
      fileId: file.file_id, fileUniqueId: file.file_unique_id, messageId: ctx.message.message_id, payloadKind: "video",
      fileName: file.file_name || `telegram-video-${file.file_unique_id}.mp4`,
      ...(file.mime_type ? { declaredMediaType: file.mime_type } : {}),
      ...(ctx.message.caption ? { caption: ctx.message.caption } : {}),
      ...(ctx.message.media_group_id ? { mediaGroupId: ctx.message.media_group_id } : {}),
      ...(file.file_size === undefined ? {} : { fileSizeBytes: file.file_size }), forwarded: forwarded(ctx.message),
    });
  });

  bot.on("animation", async (ctx) => {
    const file = ctx.message.animation;
    await handleFile(ctx, {
      fileId: file.file_id, fileUniqueId: file.file_unique_id, messageId: ctx.message.message_id, payloadKind: "animation",
      fileName: file.file_name || `telegram-animation-${file.file_unique_id}.mp4`,
      ...(file.mime_type ? { declaredMediaType: file.mime_type } : {}),
      ...(ctx.message.caption ? { caption: ctx.message.caption } : {}),
      ...(file.file_size === undefined ? {} : { fileSizeBytes: file.file_size }), forwarded: forwarded(ctx.message),
    });
  });

  bot.on("video_note", async (ctx) => {
    if (!await privateChat(ctx)) return;
    await shell.handleUnsupportedAttachment(String(ctx.chat.id), ctx.from ? String(ctx.from.id) : undefined);
  });

  bot.on("voice", async (ctx) => {
    if (!await privateChat(ctx)) return;
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
    const callbackQueryId = ctx.callbackQuery.id;
    const data = ("data" in ctx.callbackQuery) ? ctx.callbackQuery.data : "";
    const chatId = ctx.chat ? String(ctx.chat.id) : ctx.callbackQuery.message ? String(ctx.callbackQuery.message.chat.id) : "";
    const messageId = ctx.callbackQuery.message?.message_id;
    await shell.handleCallback(chatId, callbackQueryId, data || "", ctx.from ? String(ctx.from.id) : undefined, messageId);
  });

  return bot;
}
