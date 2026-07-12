import { existsSync, readFileSync } from "node:fs";
import { MinutkaClient } from "../client/sdk/minutka-client.js";
import { createInProcessServer } from "../server/http/in-process-server.js";
import { createPostgresRuntime } from "../runtime/create-postgres-runtime.js";
import { createTelegramShell, maxTelegramMessageCharacters } from "./telegram-shell.js";
import { createTelegrafBot } from "./telegraf-runtime.js";
import { runMinutkaAgent } from "../mastra/agent-runner.js";
import type { TelegramReplyPort } from "./telegram-types.js";
import { Telegraf } from "telegraf";
import { parseInviteSeeds } from "./invite-seeds.js";

if (existsSync(".env")) for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) { const trimmed = line.trim(); const index = trimmed.indexOf("="); if (trimmed && !trimmed.startsWith("#") && index !== -1 && !process.env[trimmed.slice(0, index).trim()]) process.env[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim(); }

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not set in environment.");
  const runtime = await createPostgresRuntime({ agentRunner: runMinutkaAgent, env: process.env });
  let activeBot: Telegraf | null = null;
  const replyPort: TelegramReplyPort = {
    async sendMessage(chatId, text, options) {
      if (Array.from(text).length > maxTelegramMessageCharacters) throw new Error(`Telegram message exceeds the ${maxTelegramMessageCharacters}-character limit`);
      if (!activeBot) throw new Error("Bot not running");
      const reply_markup = options?.replyMarkup ? { inline_keyboard: options.replyMarkup.inlineKeyboard.map((row) => row.map((button) => ({ text: button.text, callback_data: button.callbackData }))) } : undefined;
      await activeBot.telegram.sendMessage(chatId, text, { reply_markup });
    },
    async sendChatAction(chatId, action) {
      if (!activeBot) throw new Error("Bot not running");
      await activeBot.telegram.sendChatAction(chatId, action);
    },
    async answerCallbackQuery(callbackQueryId, text) { if (!activeBot) throw new Error("Bot not running"); await activeBot.telegram.answerCbQuery(callbackQueryId, text?.slice(0, 200)); },
  };
  const client = new MinutkaClient(createInProcessServer(runtime.service));
  for (const seed of parseInviteSeeds(process.env.TELEGRAM_INVITES)) await client.issueInvite(seed);
  const shell = createTelegramShell({ client, sessionStore: runtime.telegramSessionStore, replyPort });
  activeBot = createTelegrafBot({ token, shell });
  let shutdownPromise: Promise<void> | undefined;
  let launchCompleted: Promise<void> | undefined;
  const shutdown = (signal: string) => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      console.log(`Stopping bot (${signal})...`);
      try {
        activeBot?.stop(signal);
        // stop() only aborts polling. Telegraf resolves launch() after pending
        // update handlers settle, so keep the database alive until they finish.
        await launchCompleted;
      } finally {
        await runtime.shutdown();
      }
    })();
    return shutdownPromise;
  };
  const requestShutdown = (signal: string) => {
    if (shutdownPromise) {
      console.error("Forced shutdown requested.");
      process.exit(1);
    }
    void shutdown(signal).catch((error) => {
      console.error(`Graceful shutdown failed (${error instanceof Error ? error.name : "UnknownError"}).`);
      process.exitCode = 1;
    });
  };
  const launchBot = () => {
    launchCompleted = activeBot.launch();
    return launchCompleted;
  };
  process.on("SIGINT", () => requestShutdown("SIGINT")); process.on("SIGTERM", () => requestShutdown("SIGTERM"));
  console.log("Minutka Telegram Bot is running with PostgreSQL runtime.");
  await launchBot();
}
main().catch((error) => { console.error("Fatal error in main:", error instanceof Error ? error.message : "unknown error"); process.exit(1); });
