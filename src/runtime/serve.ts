import { Readable } from "node:stream";
import { ServiceMinutkaClient } from "../client/sdk/minutka-client.js";
import { HttpServiceMinutkaTransport } from "../client/sdk/http-transport.js";
import { apiAuthConfigFromEnv } from "../server/http/auth.js";
import { listenHttpServer } from "../server/http/http-server.js";
import { createPostgresRuntime } from "./create-postgres-runtime.js";
import { sttConfigFromEnv } from "./stt-config.js";
import { createAssistantAgentRunner } from "../mastra/agent-runner.js";
import { personalAssistantAgent } from "../mastra/agents/personal-assistant-agent.js";
import { createOpenAiSpeechToText } from "../mastra/voice-transcriber.js";
import { createTelegramShell } from "../telegram/telegram-shell.js";
import type { AssistantChatResult } from "../application/assistant-service.js";
import { createTelegrafBot } from "../telegram/telegraf-runtime.js";
import { createTelegrafReplyPort } from "../telegram/telegraf-reply-port.js";
import { parseInviteSeeds } from "../telegram/invite-seeds.js";
import { Telegraf } from "telegraf";
import { loadDotEnv } from "../config/env.js";
import type { TelegramVoiceFileGateway } from "../telegram/telegram-voice-file-gateway.js";
import { createTelegramFileGateway } from "../telegram/telegram-file-gateway.js";
import { assertAssistantTimeoutBudgets, productionAssistantTimeoutBudgets } from "../config/assistant-timeout-budgets.js";
import { startTransports } from "./transport-startup.js";

function apiPort(value: string | undefined): number { const port = Number(value ?? "8787"); if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("MINUTKA_API_PORT must be a valid port"); return port; }
function booleanEnv(value: string | undefined, name: string): boolean { if (value === undefined || value === "false") return false; if (value === "true") return true; throw new Error(`${name} must be true or false`); }

async function main(): Promise<void> {
  loadDotEnv(); const timeoutBudgets = assertAssistantTimeoutBudgets(productionAssistantTimeoutBudgets); const auth = apiAuthConfigFromEnv(process.env);
  let activeBot: Telegraf | undefined;
  let telegramShell: ReturnType<typeof createTelegramShell> | undefined;
  const replyPort = createTelegrafReplyPort(() => activeBot?.telegram);
  const telegramMode = process.env.TELEGRAM_MODE ?? "disabled";
  if (telegramMode !== "disabled" && telegramMode !== "polling") throw new Error("TELEGRAM_MODE must be disabled or polling");
  const telegramEnabled = telegramMode === "polling";
  const runtime = await createPostgresRuntime({
    assistantAgentRunner: createAssistantAgentRunner(personalAssistantAgent),
    env: process.env,
    ...(telegramEnabled ? { telegramShell: { deliverProactive: (chatId: string, result: AssistantChatResult, employeeId: string) => {
      if (!telegramShell) throw new Error("Telegram shell is not configured.");
      return telegramShell.deliverProactive(chatId, result, employeeId);
    } } } : {}),
  });
  let listener: Awaited<ReturnType<typeof listenHttpServer>> | undefined; let bot: Telegraf | undefined; let launchCompleted: Promise<void> | undefined;
  try {
    listener = await listenHttpServer({
      application: runtime.assistant,
      auth,
      health: runtime.health,
      host: process.env.MINUTKA_API_HOST,
      port: apiPort(process.env.MINUTKA_API_PORT),
      allowNonLoopback: booleanEnv(process.env.MINUTKA_API_ALLOW_NON_LOOPBACK, "MINUTKA_API_ALLOW_NON_LOOPBACK"),
      trustProxy: booleanEnv(process.env.MINUTKA_API_TRUST_PROXY, "MINUTKA_API_TRUST_PROXY"),
      timeoutBudgets,
    });
    const inviteSeeds = parseInviteSeeds(process.env.TELEGRAM_INVITES);
    if (inviteSeeds.length) {
      // Seeds are trusted startup configuration, not operator traffic; bypass the
      // per-operator abuse limiter so a valid large seed set can start atomically.
      for (const seed of inviteSeeds) await runtime.assistant.issueInvite(seed);
    }
    if (telegramEnabled) {
      const token = process.env.TELEGRAM_BOT_TOKEN; const serviceToken = process.env.MINUTKA_SERVICE_TOKEN;
      if (!token || !serviceToken) throw new Error("TELEGRAM_MODE=polling requires TELEGRAM_BOT_TOKEN and MINUTKA_SERVICE_TOKEN");
      const stt = sttConfigFromEnv(process.env);
      const client = new ServiceMinutkaClient(new HttpServiceMinutkaTransport({ baseUrl: listener.url, token: serviceToken, timeoutMs: timeoutBudgets.sdkTransportMs }));
      const voiceFileGateway: TelegramVoiceFileGateway | undefined = stt ? {
        async openVoiceFile(fileId, signal) {
          if (!activeBot) throw new Error("Bot not running");
          const url = await activeBot.telegram.getFileLink(fileId);
          const response = await fetch(url, { signal });
          if (!response.ok || !response.body) {
            void response.body?.cancel().catch(() => undefined);
            throw new Error(`Voice file download failed (${response.status})`);
          }
          return { stream: Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), filetype: "ogg" };
        },
      } : undefined;
      const speechToText = stt ? createOpenAiSpeechToText(stt) : undefined;
      const fileGateway = createTelegramFileGateway({
        async getFileLink(fileId) {
          if (!activeBot) throw new Error("Bot not running");
          return activeBot.telegram.getFileLink(fileId);
        },
      });
      telegramShell = createTelegramShell({ client, sessionStore: runtime.telegramSessionStore, replyPort, privacyExplanation: runtime.privacyExplanation, artifactIntake: runtime.assistant, fileGateway, artifactMaximumBytes: runtime.artifactMaximumBytes, speechToText, voiceFileGateway });
      bot = createTelegrafBot({ token, shell: telegramShell }); activeBot = bot;
    }
    const telegramBot = bot;
    ({ launchCompleted } = await startTransports({
      startScheduler: runtime.startScheduler,
      launchTelegram: telegramBot ? () => telegramBot.launch() : undefined,
    }));
    console.log(`Minutka HTTP API listening on ${listener.url}`);
  } catch (error) {
    try { await listener?.close(); } finally { await runtime.shutdown(); }
    throw error;
  }
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return process.exit(1);
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
  void launchCompleted?.catch((error: unknown) => {
    console.error(`Telegram polling failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return shutdown("TELEGRAM_POLLING_ERROR");
  }).catch(() => { process.exitCode = 1; });
  process.on("SIGINT", () => void shutdown("SIGINT").catch(() => { process.exitCode = 1; })); process.on("SIGTERM", () => void shutdown("SIGTERM").catch(() => { process.exitCode = 1; }));
}
main().catch((error) => { console.error(`Fatal error: ${error instanceof Error ? error.message : "unknown error"}`); process.exit(1); });
