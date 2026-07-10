import { existsSync, readFileSync } from "node:fs";
import { createInMemoryWorld } from "../application/in-memory-world.js";
import { createInProcessServer } from "../server/http/in-process-server.js";
import { MinutkaClient } from "../client/sdk/minutka-client.js";
import { createInMemoryTelegramSessionStore } from "./in-memory-telegram-session-store.js";
import { createTelegramShell } from "./telegram-shell.js";
import { createTelegrafBot } from "./telegraf-runtime.js";
import { runMinutkaAgent } from "../mastra/agent-runner.js";
import type { TelegramReplyPort } from "./telegram-types.js";
import { Telegraf } from "telegraf";

// Load .env manually if it exists to avoid external dependencies
if (existsSync(".env")) {
  const envContent = readFileSync(".env", "utf8");
  for (const line of envContent.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index !== -1) {
      const key = trimmed.substring(0, index).trim();
      const val = trimmed.substring(index + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

async function main() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.error("TELEGRAM_BOT_TOKEN is not set in environment.");
    process.exit(1);
  }

  console.log("Starting Minutka Telegram Bot...");

  const world = createInMemoryWorld();
  const sessionStore = createInMemoryTelegramSessionStore();

  let activeBot: Telegraf | null = null;

  const replyPort: TelegramReplyPort = {
    async sendMessage(chatId, text, options) {
      if (!activeBot) throw new Error("Bot not running");
      let replyMarkup = undefined;
      if (options?.replyMarkup?.inlineKeyboard) {
        replyMarkup = {
          inline_keyboard: options.replyMarkup.inlineKeyboard.map((row) =>
            row.map((btn) => ({
              text: btn.text,
              callback_data: btn.callbackData,
            }))
          ),
        };
      }
      await activeBot.telegram.sendMessage(chatId, text, { reply_markup: replyMarkup });
    },
    async answerCallbackQuery(callbackQueryId, text) {
      if (!activeBot) throw new Error("Bot not running");
      await activeBot.telegram.answerCbQuery(callbackQueryId, text);
    },
  };

  const server = createInProcessServer(world, runMinutkaAgent);
  const client = new MinutkaClient(server);
  const shell = createTelegramShell({ client, sessionStore, replyPort });

  activeBot = createTelegrafBot({ token, shell });

  // Enable graceful stop
  process.once("SIGINT", () => {
    console.log("Stopping bot (SIGINT)...");
    activeBot?.stop("SIGINT");
  });
  process.once("SIGTERM", () => {
    console.log("Stopping bot (SIGTERM)...");
    activeBot?.stop("SIGTERM");
  });

  await activeBot.launch();
  console.log("Minutka Telegram Bot is running successfully.");
}

main().catch((err) => {
  console.error("Fatal error in main:", err);
  process.exit(1);
});
