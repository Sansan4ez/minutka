import { describe, expect, it } from "vitest";
import { createTelegrafBot } from "../../../src/telegram/telegraf-runtime.js";
import { createTelegrafReplyPort } from "../../../src/telegram/telegraf-reply-port.js";

const botInfo = { id: 999, is_bot: true as const, first_name: "Assistant", username: "assistant_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false };
const baseMessage = { date: 1, chat: { id: 1, type: "private" as const }, from: { id: 2, is_bot: false, first_name: "Owner" } };

function update(message: object, updateId: number) {
  return { update_id: updateId, message: { ...baseMessage, message_id: updateId, ...message } } as any;
}

describe("SPEC-TELEGRAF-ROUTING-001: Telegram payload-kind routing", () => {
  it("maps the reply contract to Telegraf HTML parse mode", async () => {
    const calls: Array<{ chatId: string; text: string; options: Record<string, unknown> }> = [];
    const telegram = {
      async sendMessage(chatId: string, text: string, options: Record<string, unknown>) { calls.push({ chatId, text, options }); return { message_id: 17 }; },
      async editMessageReplyMarkup() {}, async sendChatAction() {}, async answerCbQuery() {},
    };
    const replyPort = createTelegrafReplyPort(() => telegram as any);

    const sent = await replyPort.sendMessage("chat", "<b>Важно</b>", { parseMode: "HTML", replyToMessageId: 11 });

    expect(sent).toEqual({ messageId: 17 });
    expect(calls).toEqual([{ chatId: "chat", text: "<b>Важно</b>", options: { parse_mode: "HTML", reply_parameters: { message_id: 11 }, reply_markup: undefined } }]);
  });

  it("registers save-only handlers for supported files and keeps forwarded voice on the STT path", async () => {
    const files: any[] = [];
    const voices: any[] = [];
    const unsupported: string[] = [];
    const shell = {
      async handleStart() {}, async handleText() {}, async handleCallback() {},
      async handleFile(chatId: string, file: unknown, userId?: string) { files.push({ chatId, userId, file }); },
      async handleVoice(chatId: string, voice: unknown, userId?: string) { voices.push({ chatId, userId, voice }); },
      async handleUnsupportedAttachment(chatId: string) { unsupported.push(chatId); },
    };
    const bot = createTelegrafBot({ token: "test", shell: shell as any });
    bot.botInfo = botInfo;

    await bot.handleUpdate(update({ photo: [{ file_id: "photo", file_unique_id: "photo-u", width: 1, height: 1, file_size: 5 }], caption: "image", media_group_id: "album" }, 10));
    await bot.handleUpdate(update({ document: { file_id: "doc", file_unique_id: "doc-u", file_name: "report.pdf", mime_type: "application/pdf", file_size: 6 }, forward_origin: { type: "hidden_user", sender_user_name: "Forwarded", date: 1 } }, 11));
    await bot.handleUpdate(update({ audio: { file_id: "audio", file_unique_id: "audio-u", duration: 1, file_name: "recording.mp3", mime_type: "audio/mpeg", file_size: 7 } }, 12));
    await bot.handleUpdate(update({ video: { file_id: "video", file_unique_id: "video-u", width: 1, height: 1, duration: 1, file_name: "clip.mp4", mime_type: "video/mp4", file_size: 8 } }, 13));
    await bot.handleUpdate(update({ animation: { file_id: "animation", file_unique_id: "animation-u", width: 1, height: 1, duration: 1, file_name: "loop.mp4", mime_type: "video/mp4", file_size: 9 } }, 14));
    await bot.handleUpdate(update({ video_note: { file_id: "note", file_unique_id: "note-u", length: 1, duration: 1 } }, 15));
    await bot.handleUpdate(update({ voice: { file_id: "voice", file_unique_id: "voice-u", duration: 2, file_size: 10 }, forward_origin: { type: "hidden_user", sender_user_name: "Forwarded", date: 1 } }, 16));

    expect(files.map(({ file }) => file.payloadKind)).toEqual(["photo", "document", "audio", "video", "animation"]);
    expect(files[0].file).toMatchObject({ fileName: "telegram-photo-photo-u.jpg", caption: "image", mediaGroupId: "album", forwarded: false });
    expect(files[1].file).toMatchObject({ fileName: "report.pdf", declaredMediaType: "application/pdf", forwarded: true });
    expect(unsupported).toEqual(["1"]);
    expect(voices).toEqual([{ chatId: "1", userId: "2", voice: { fileId: "voice", messageId: 16, durationSeconds: 2, fileSizeBytes: 10 } }]);
  });
});
