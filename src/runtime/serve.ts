import { existsSync, readFileSync } from "node:fs";
import { Readable } from "node:stream";
import { ServiceMinutkaClient } from "../client/sdk/minutka-client.js";
import { HttpServiceMinutkaTransport } from "../client/sdk/http-transport.js";
import { apiAuthConfigFromEnv } from "../server/http/auth.js";
import { listenHttpServer } from "../server/http/http-server.js";
import { createPostgresRuntime } from "./create-postgres-runtime.js";
import { sttConfigFromEnv } from "./stt-config.js";
import { runMinutkaAgent } from "../mastra/agent-runner.js";
import { createOpenAiSpeechToText } from "../mastra/voice-transcriber.js";
import { createTelegramShell, maxTelegramMessageCharacters } from "../telegram/telegram-shell.js";
import { createTelegrafBot } from "../telegram/telegraf-runtime.js";
import type { TelegramReplyPort } from "../telegram/telegram-types.js";
import { parseInviteSeeds } from "../telegram/invite-seeds.js";
import { Telegraf } from "telegraf";
import type { TelegramVoiceFileGateway } from "../telegram/telegram-voice-file-gateway.js";

function loadDotEnv(): void { if (!existsSync(".env")) return; for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) { const trimmed = line.trim(); const index = trimmed.indexOf("="); if (trimmed && !trimmed.startsWith("#") && index !== -1 && !process.env[trimmed.slice(0, index).trim()]) process.env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim(); } }
function apiPort(value: string | undefined): number { const port = Number(value ?? "8787"); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MINUTKA_API_PORT must be a valid port"); return port; }
function booleanEnv(value: string | undefined, name: string): boolean { if (value === undefined || value === "false") return false; if (value === "true") return true; throw new Error(`${name} must be true or false`); }

async function main(): Promise<void> {
  loadDotEnv(); const auth = apiAuthConfigFromEnv(process.env); const runtime = await createPostgresRuntime({ agentRunner: runMinutkaAgent, env: process.env });
  let listener: Awaited<ReturnType<typeof listenHttpServer>> | undefined; let bot: Telegraf | undefined; let launchCompleted: Promise<void> | undefined;
  try {
    listener = await listenHttpServer({
      service: runtime.service,
      auth,
      health: runtime.health,
      host: process.env.MINUTKA_API_HOST,
      port: apiPort(process.env.MINUTKA_API_PORT),
      allowNonLoopback: booleanEnv(process.env.MINUTKA_API_ALLOW_NON_LOOPBACK, "MINUTKA_API_ALLOW_NON_LOOPBACK"),
      trustProxy: booleanEnv(process.env.MINUTKA_API_TRUST_PROXY, "MINUTKA_API_TRUST_PROXY"),
    });
    const inviteSeeds = parseInviteSeeds(process.env.TELEGRAM_INVITES);
    if (inviteSeeds.length) {
      // Seeds are trusted startup configuration, not operator traffic; bypass the
      // per-operator abuse limiter so a valid large seed set can start atomically.
      for (const seed of inviteSeeds) await runtime.service.issueInvite(seed);
    }
    if ((process.env.TELEGRAM_MODE ?? "disabled") === "polling") {
      const token = process.env.TELEGRAM_BOT_TOKEN; const serviceToken = process.env.MINUTKA_SERVICE_TOKEN;
      if (!token || !serviceToken) throw new Error("TELEGRAM_MODE=polling requires TELEGRAM_BOT_TOKEN and MINUTKA_SERVICE_TOKEN");
      const stt = sttConfigFromEnv(process.env);
      let activeBot: Telegraf | undefined;
      const replyPort: TelegramReplyPort = {
        async sendMessage(chatId, text, options) {
          if (Array.from(text).length > maxTelegramMessageCharacters) throw new Error("Telegram message exceeds the 4000-character limit");
          if (!activeBot) throw new Error("Bot not running");
          await activeBot.telegram.sendMessage(chatId, text, {
            ...(options?.replyToMessageId === undefined ? {} : { reply_parameters: { message_id: options.replyToMessageId } }),
            reply_markup: options?.replyMarkup ? { inline_keyboard: options.replyMarkup.inlineKeyboard.map((row) => row.map((button) => ({ text: button.text, callback_data: button.callbackData }))) } : undefined,
          });
        },
        async sendChatAction(chatId, action) { if (!activeBot) throw new Error("Bot not running"); await activeBot.telegram.sendChatAction(chatId, action); },
        async answerCallbackQuery(id, text) { if (!activeBot) throw new Error("Bot not running"); await activeBot.telegram.answerCbQuery(id, text?.slice(0, 200)); },
      };
      const client = new ServiceMinutkaClient(new HttpServiceMinutkaTransport({ baseUrl: listener.url, token: serviceToken }));
      const voiceFileGateway: TelegramVoiceFileGateway | undefined = stt ? {
        async openVoiceFile(fileId) {
          if (!activeBot) throw new Error("Bot not running");
          const url = await activeBot.telegram.getFileLink(fileId);
          const response = await fetch(url);
          if (!response.ok || !response.body) {
            void response.body?.cancel().catch(() => undefined);
            throw new Error(`Voice file download failed (${response.status})`);
          }
          return { stream: Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), filetype: "ogg" };
        },
      } : undefined;
      const speechToText = stt ? createOpenAiSpeechToText(stt) : undefined;
      bot = createTelegrafBot({ token, shell: createTelegramShell({ client, sessionStore: runtime.telegramSessionStore, replyPort, speechToText, voiceFileGateway }) }); activeBot = bot; launchCompleted = bot.launch();
    } else if ((process.env.TELEGRAM_MODE ?? "disabled") !== "disabled") throw new Error("TELEGRAM_MODE must be disabled or polling");
    console.log(`Minutka HTTP API listening on ${listener.url}`);
  } catch (error) {
    try { await listener?.close(); } finally { await runtime.shutdown(); }
    throw error;
  }
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) { process.exit(1); return; }
    shuttingDown = true;
    console.log(`Stopping Minutka (${signal})...`);
    try {
      // Telegram handlers call the loopback API, so drain polling before closing it.
      try {
        bot?.stop(signal);
        await launchCompleted;
      } finally {
        await listener?.close();
      }
    } finally {
      await runtime.shutdown();
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT").catch(() => { process.exitCode = 1; })); process.on("SIGTERM", () => void shutdown("SIGTERM").catch(() => { process.exitCode = 1; }));
}
main().catch((error) => { console.error(`Fatal error: ${error instanceof Error ? error.message : "unknown error"}`); process.exit(1); });
