import { ServiceMinutkaClient } from "../../../src/client/sdk/minutka-client.js";
import { createInProcessServiceTransport } from "../../../src/server/http/in-process-transport.js";
import { createInMemoryRuntime } from "../../../src/runtime/create-in-memory-runtime.js";
import { createTelegramShell } from "../../../src/telegram/telegram-shell.js";
import type { TelegramReplyMarkup, TelegramReplyPort } from "../../../src/telegram/telegram-types.js";
import type { InMemoryWorld } from "../../../src/application/in-memory-world.js";
import type { AgentRunner, MinutkaServiceDeps } from "../../../src/application/minutka-service.js";
import { createDefaultSpecDeps } from "./scripted-deps.js";
import { encodeFeedbackCallbackData } from "../../../src/telegram/callback-data.js";
import type { FeedbackRating } from "../../../src/domain/feedback.js";

export type SentMessage = { chatId: string; text: string; replyMarkup?: TelegramReplyMarkup };
export type CallbackAnswer = { callbackQueryId: string; text?: string };

export class TelegramDriver {
  private readonly shell: ReturnType<typeof createTelegramShell>;
  private readonly sent: SentMessage[] = [];
  private readonly callbacks: CallbackAnswer[] = [];
  private readonly chatActions: Array<{ chatId: string; action: "typing" }> = [];
  private failNextSend = false;

  constructor(world: InMemoryWorld, agentRunner: AgentRunner, deps: MinutkaServiceDeps = {}) {
    const runtime = createInMemoryRuntime({ world, agentRunner, deps: createDefaultSpecDeps(deps) });
    const client = new ServiceMinutkaClient(createInProcessServiceTransport(runtime.service, { kind: "service", serviceId: "telegram-spec" }));
    const self = this;
    const replyPort: TelegramReplyPort = {
      async sendMessage(chatId, text, options) {
        if (self.failNextSend) { self.failNextSend = false; throw new Error("simulated Telegram delivery failure"); }
        self.sent.push({ chatId, text, replyMarkup: options?.replyMarkup });
      },
      async sendChatAction(chatId, action) { self.chatActions.push({ chatId, action }); },
      async answerCallbackQuery(callbackQueryId, text) { self.callbacks.push({ callbackQueryId, text }); },
    };
    this.shell = createTelegramShell({ client, sessionStore: runtime.telegramSessionStore, replyPort });
  }

  async start(input: { chatId: string; userId?: string; inviteCode?: string }): Promise<void> { await this.shell.handleStart(input.chatId, input.inviteCode, input.userId ?? this.defaultUserId(input.chatId)); }
  async sendText(input: { chatId: string; userId?: string; text: string }): Promise<void> { await this.shell.handleText(input.chatId, input.text, input.userId ?? this.defaultUserId(input.chatId)); }
  async clickFeedback(input: { chatId: string; userId?: string; rating: FeedbackRating; targetMessageId: string }): Promise<void> { await this.shell.handleCallback(input.chatId, `cb_${Date.now()}`, encodeFeedbackCallbackData(input.rating, input.targetMessageId), input.userId ?? this.defaultUserId(input.chatId)); }
  async clickCallback(input: { chatId: string; userId?: string; callbackData: string }): Promise<void> { await this.shell.handleCallback(input.chatId, `cb_${Date.now()}`, input.callbackData, input.userId ?? this.defaultUserId(input.chatId)); }
  failNextMessageDelivery(): void { this.failNextSend = true; }
  sentMessages(): SentMessage[] { return this.sent; }
  callbackAnswers(): CallbackAnswer[] { return this.callbacks; }
  sentChatActions(): Array<{ chatId: string; action: "typing" }> { return this.chatActions; }
  clear() { this.sent.length = 0; this.callbacks.length = 0; this.chatActions.length = 0; }
  private defaultUserId(chatId: string): string { return `user_${chatId}`; }
}
