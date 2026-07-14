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
import { Readable } from "node:stream";
import type { SpeechToTextPort } from "../../../src/application/speech-to-text.js";
import type { TelegramVoiceFileGateway } from "../../../src/telegram/telegram-voice-file-gateway.js";

export type VoiceInput = { chatId: string; userId?: string; fileId: string; durationSeconds: number; fileSizeBytes?: number; audioBytes?: number; transcript?: string; error?: "download" | "transcribe" };

export type SentMessage = { chatId: string; text: string; replyMarkup?: TelegramReplyMarkup };
export type CallbackAnswer = { callbackQueryId: string; text?: string };

export class TelegramDriver {
  private readonly shell: ReturnType<typeof createTelegramShell>;
  private readonly sent: SentMessage[] = [];
  private readonly callbacks: CallbackAnswer[] = [];
  private readonly chatActions: Array<{ chatId: string; action: "typing" }> = [];
  private failNextSend = false;
  private readonly voiceFiles = new Map<string, Buffer>();
  private readonly voiceTranscripts = new Map<string, string>();
  private readonly voiceErrors = new Map<string, "download" | "transcribe">();
  private readonly voiceFileIds = new WeakMap<NodeJS.ReadableStream, string>();
  private readonly voiceDownloads: string[] = [];
  private readonly transcriptions: string[] = [];

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
    const voiceFileGateway: TelegramVoiceFileGateway = {
      openVoiceFile: async (fileId) => {
        this.voiceDownloads.push(fileId);
        if (this.voiceErrors.get(fileId) === "download") throw new Error("simulated voice download failure");
        const stream = Readable.from(this.voiceFiles.get(fileId) ?? Buffer.from("voice"));
        this.voiceFileIds.set(stream, fileId);
        return { stream, filetype: "ogg" };
      },
    };
    const speechToText: SpeechToTextPort = {
      transcribe: async ({ audio }) => {
        const chunks: Buffer[] = [];
        for await (const chunk of audio) chunks.push(Buffer.from(chunk)); // consume fake audio like a real provider
        const data = Buffer.concat(chunks);
        const separator = data.indexOf(0);
        const fileId = this.voiceFileIds.get(audio) ?? data.subarray(0, separator === -1 ? data.length : separator).toString("utf8");
        this.transcriptions.push(fileId);
        if (this.voiceErrors.get(fileId) === "transcribe") throw new Error("simulated STT failure");
        return this.voiceTranscripts.get(fileId) ?? "";
      },
    };
    this.shell = createTelegramShell({ client, sessionStore: runtime.telegramSessionStore, replyPort, speechToText, voiceFileGateway });
  }

  async start(input: { chatId: string; userId?: string; inviteCode?: string }): Promise<void> { await this.shell.handleStart(input.chatId, input.inviteCode, input.userId ?? this.defaultUserId(input.chatId)); }
  async sendText(input: { chatId: string; userId?: string; text: string }): Promise<void> { await this.shell.handleText(input.chatId, input.text, input.userId ?? this.defaultUserId(input.chatId)); }
  async sendVoice(input: VoiceInput): Promise<void> {
    this.voiceFiles.set(input.fileId, Buffer.concat([Buffer.from(`${input.fileId}\0`), Buffer.alloc(input.audioBytes ?? 0)]));
    this.voiceTranscripts.set(input.fileId, input.transcript ?? "");
    if (input.error) this.voiceErrors.set(input.fileId, input.error); else this.voiceErrors.delete(input.fileId);
    await this.shell.handleVoice(input.chatId, { fileId: input.fileId, durationSeconds: input.durationSeconds, ...(input.fileSizeBytes === undefined ? {} : { fileSizeBytes: input.fileSizeBytes }) }, input.userId ?? this.defaultUserId(input.chatId));
  }
  async clickFeedback(input: { chatId: string; userId?: string; rating: FeedbackRating; targetMessageId: string }): Promise<void> { await this.shell.handleCallback(input.chatId, `cb_${Date.now()}`, encodeFeedbackCallbackData(input.rating, input.targetMessageId), input.userId ?? this.defaultUserId(input.chatId)); }
  async clickCallback(input: { chatId: string; userId?: string; callbackData: string }): Promise<void> { await this.shell.handleCallback(input.chatId, `cb_${Date.now()}`, input.callbackData, input.userId ?? this.defaultUserId(input.chatId)); }
  failNextMessageDelivery(): void { this.failNextSend = true; }
  sentMessages(): SentMessage[] { return this.sent; }
  callbackAnswers(): CallbackAnswer[] { return this.callbacks; }
  sentChatActions(): Array<{ chatId: string; action: "typing" }> { return this.chatActions; }
  voiceDownloadCalls(): string[] { return [...this.voiceDownloads]; }
  transcriptionCalls(): string[] { return [...this.transcriptions]; }
  clear() { this.sent.length = 0; this.callbacks.length = 0; this.chatActions.length = 0; this.voiceDownloads.length = 0; this.transcriptions.length = 0; }
  private defaultUserId(chatId: string): string { return `user_${chatId}`; }
}
