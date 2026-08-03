import { ServiceMinutkaClient } from "../../../src/client/sdk/minutka-client.js";
import { createInProcessServiceTransport } from "../../../src/server/http/in-process-transport.js";
import { createInMemoryRuntime, executableSpecPrivacyExplanation } from "../../../src/runtime/create-in-memory-runtime.js";
import { createTelegramShell, type TelegramArtifactIntake, type TelegramFileAttachment } from "../../../src/telegram/telegram-shell.js";
import type { TelegramParseMode, TelegramReplyMarkup, TelegramReplyPort } from "../../../src/telegram/telegram-types.js";
import type { InMemoryWorld } from "../../../src/application/in-memory-world.js";
import type { AgentRunner, MinutkaServiceDeps } from "../../../src/application/minutka-service.js";
import { PersonalAssistantService } from "../../../src/application/personal-assistant-service.js";
import { createDefaultSpecDeps } from "./scripted-deps.js";
import { encodeFeedbackCallbackData } from "../../../src/telegram/callback-data.js";
import type { FeedbackRating } from "../../../src/domain/feedback.js";
import { Readable } from "node:stream";
import type { SpeechToTextPort } from "../../../src/application/speech-to-text.js";
import type { TelegramVoiceFileGateway } from "../../../src/telegram/telegram-voice-file-gateway.js";
import type { AssistantChatResult } from "../../../src/application/assistant-service.js";

export type VoiceInput = { chatId: string; userId?: string; fileId: string; messageId?: number; durationSeconds: number; fileSizeBytes?: number; audioBytes?: number; transcript?: string; error?: "download" | "download-hang" | "transcribe" | "stream" | "hang" };

export type SentMessage = { messageId: number; chatId: string; text: string; parseMode?: TelegramParseMode; replyMarkup?: TelegramReplyMarkup; replyToMessageId?: number };
export type CallbackAnswer = { callbackQueryId: string; text?: string };
export type ReplyMarkupEdit = { chatId: string; messageId: number; replyMarkup?: TelegramReplyMarkup };

export class TelegramDriver {
  private readonly shell: ReturnType<typeof createTelegramShell>;
  private readonly sent: SentMessage[] = [];
  private readonly callbacks: CallbackAnswer[] = [];
  private readonly replyMarkupEdits: ReplyMarkupEdit[] = [];
  private readonly chatActions: Array<{ chatId: string; action: "typing" }> = [];
  private failNextChatAction = false;
  private nextMessageId = 1;
  private readonly sendOutcomes: Array<"pass" | "fail" | "deliver_then_fail"> = [];
  private readonly deliveryAttempts: Array<Omit<SentMessage, "messageId">> = [];
  private failNextMarkupEdit = false;
  private failNextTaskReject = false;
  private readonly taskRejects: string[] = [];
  private readonly voiceFiles = new Map<string, Buffer>();
  private readonly voiceTranscripts = new Map<string, string>();
  private readonly voiceErrors = new Map<string, "download" | "download-hang" | "transcribe" | "stream" | "hang">();
  private readonly voiceFileIds = new WeakMap<NodeJS.ReadableStream, string>();
  private readonly closedVoiceStreams: string[] = [];
  private readonly voiceDownloads: string[] = [];
  private readonly transcriptions: string[] = [];

  constructor(world: InMemoryWorld, agentRunner: AgentRunner, deps: MinutkaServiceDeps = {}, voiceEnabled = true, voiceProcessingTimeoutMs?: number, runtimeInput?: Omit<ReturnType<typeof createInMemoryRuntime>, "service"> & { service: ReturnType<typeof createInMemoryRuntime>["service"] | PersonalAssistantService }, artifactIntake?: TelegramArtifactIntake) {
    const runtime = runtimeInput ?? createInMemoryRuntime({ world, agentRunner, deps: createDefaultSpecDeps(deps) });
    const baseTransport = createInProcessServiceTransport(runtime.service, { kind: "service", serviceId: "telegram-spec" });
    const self = this;
    const transport = runtime.service instanceof PersonalAssistantService ? {
      redeemTelegramInvite: (input: Parameters<typeof baseTransport.redeemTelegramInvite>[0]) => baseTransport.redeemTelegramInvite(input),
      forEmployee(employeeId: string) {
        const scoped = baseTransport.forEmployee(employeeId);
        return new Proxy(scoped, {
          get(target, property, receiver) {
            if (property === "chat") return async (input: Parameters<typeof scoped.chat>[0]) => {
              const result = await (runtime.service as PersonalAssistantService).chat({ userId: employeeId, threadId: input.threadId, text: input.text, inputModality: input.inputModality, responseChannel: input.responseChannel });
              return { messageId: result.messageId, response: result.response, selectedProcessIds: result.selectedProcessIds, ...(result.pendingAction ? { pendingAction: result.pendingAction } : {}), effect: result.effect };
            };
            if (property === "resetConversation") return () => (runtime.service as PersonalAssistantService).resetConversation({ userId: employeeId });
            if (property === "listSchedules") return async () => ({ schedules: (await (runtime.service as PersonalAssistantService).listSchedules(employeeId)).map(({ id, processId, timeOfDay, timezone, enabled, nextFireAt }) => ({ id, processId, timeOfDay, timezone, enabled, nextFireAt })) });
            if (property === "rejectTaskMutation" || property === "rejectContextDocumentMutation") return async (confirmationId: string, input: {}) => {
              self.taskRejects.push(confirmationId);
              if (self.failNextTaskReject) { self.failNextTaskReject = false; throw new Error("simulated task rejection failure"); }
              return property === "rejectTaskMutation"
                ? scoped.rejectTaskMutation(confirmationId, input)
                : scoped.rejectContextDocumentMutation(confirmationId, input);
            };
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    } : baseTransport;
    const client = new ServiceMinutkaClient(transport);
    const replyPort: TelegramReplyPort = {
      async sendMessage(chatId, text, options) {
        self.deliveryAttempts.push({ chatId, text, parseMode: options?.parseMode, replyMarkup: options?.replyMarkup, replyToMessageId: options?.replyToMessageId });
        const outcome = self.sendOutcomes.shift();
        if (outcome === "fail") throw new Error("simulated Telegram delivery failure");
        const messageId = self.nextMessageId++;
        self.sent.push({ messageId, chatId, text, parseMode: options?.parseMode, replyMarkup: options?.replyMarkup, replyToMessageId: options?.replyToMessageId });
        if (outcome === "deliver_then_fail") throw new Error("simulated uncertain Telegram delivery failure");
        return { messageId };
      },
      async editReplyMarkup(chatId, messageId, replyMarkup) {
        if (self.failNextMarkupEdit) { self.failNextMarkupEdit = false; throw new Error("simulated Telegram markup cleanup failure"); }
        self.replyMarkupEdits.push({ chatId, messageId, replyMarkup });
      },
      async sendChatAction(chatId, action) {
        self.chatActions.push({ chatId, action });
        if (self.failNextChatAction) { self.failNextChatAction = false; throw new Error("simulated Telegram chat action failure"); }
      },
      async answerCallbackQuery(callbackQueryId, text) { self.callbacks.push({ callbackQueryId, text }); },
    };
    const voiceFileGateway: TelegramVoiceFileGateway = {
      openVoiceFile: async (fileId, signal) => {
        this.voiceDownloads.push(fileId);
        if (this.voiceErrors.get(fileId) === "download") throw new Error("simulated voice download failure");
        if (this.voiceErrors.get(fileId) === "download-hang") return await new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("simulated aborted voice download")), { once: true }));
        const stream = Readable.from(this.voiceFiles.get(fileId) ?? Buffer.from("voice"));
        this.voiceFileIds.set(stream, fileId);
        stream.once("close", () => this.closedVoiceStreams.push(fileId));
        if (this.voiceErrors.get(fileId) === "stream") queueMicrotask(() => stream.destroy(new Error("simulated voice stream failure")));
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
        if (this.voiceErrors.get(fileId) === "hang") return await new Promise<string>(() => undefined);
        return this.voiceTranscripts.get(fileId) ?? "";
      },
    };
    this.shell = createTelegramShell({
      privacyExplanation: executableSpecPrivacyExplanation, client,
      sessionStore: runtime.telegramSessionStore,
      replyPort,
      ...(voiceEnabled ? { speechToText, voiceFileGateway } : {}),
      ...(artifactIntake ? {
        artifactIntake,
        fileGateway: { createFileBody: ({ fileId, fileSizeBytes }) => ({ ...(fileSizeBytes === undefined ? {} : { size: fileSizeBytes }), openStream: () => Readable.from(Buffer.from(fileId)) }) },
      } : {}),
      ...(voiceProcessingTimeoutMs === undefined ? {} : { voiceProcessingTimeoutMs }),
    });
  }

  async start(input: { chatId: string; userId?: string; inviteCode?: string }): Promise<void> { await this.shell.handleStart(input.chatId, input.inviteCode, input.userId ?? this.defaultUserId(input.chatId)); }
  async startNewConversation(input: { chatId: string; userId?: string }): Promise<void> { await this.shell.handleNew(input.chatId, input.userId ?? this.defaultUserId(input.chatId)); }
  async showSchedule(input: { chatId: string; userId?: string }): Promise<void> { await this.shell.handleSchedule(input.chatId, input.userId ?? this.defaultUserId(input.chatId)); }
  async deliverProactive(input: { chatId: string; employeeId: string; result: AssistantChatResult }): Promise<void> { await this.shell.deliverProactive(input.chatId, input.result, input.employeeId); }
  async sendText(input: { chatId: string; userId?: string; text: string }): Promise<void> { await this.shell.handleText(input.chatId, input.text, input.userId ?? this.defaultUserId(input.chatId)); }
  async deliverText(input: { chatId: string; userId?: string; text: string }): Promise<void> { await this.shell.handleText(input.chatId, input.text, input.userId ?? this.defaultUserId(input.chatId)); }
  async sendFile(input: { chatId: string; userId?: string; attachment: TelegramFileAttachment }): Promise<void> { await this.shell.handleFile(input.chatId, input.attachment, input.userId ?? this.defaultUserId(input.chatId)); }
  async sendVoice(input: VoiceInput): Promise<void> {
    this.voiceFiles.set(input.fileId, Buffer.concat([Buffer.from(`${input.fileId}\0`), Buffer.alloc(input.audioBytes ?? 0)]));
    this.voiceTranscripts.set(input.fileId, input.transcript ?? "");
    if (input.error) this.voiceErrors.set(input.fileId, input.error); else this.voiceErrors.delete(input.fileId);
    await this.shell.handleVoice(input.chatId, { fileId: input.fileId, messageId: input.messageId ?? 1, durationSeconds: input.durationSeconds, ...(input.fileSizeBytes === undefined ? {} : { fileSizeBytes: input.fileSizeBytes }) }, input.userId ?? this.defaultUserId(input.chatId));
  }
  async clickFeedback(input: { chatId: string; userId?: string; rating: FeedbackRating; targetMessageId: string; messageId?: number }): Promise<void> { await this.shell.handleCallback(input.chatId, `cb_${Date.now()}`, encodeFeedbackCallbackData(input.rating, input.targetMessageId), input.userId ?? this.defaultUserId(input.chatId), input.messageId ?? this.latestActionMessageId(input.chatId)); }
  async clickCallback(input: { chatId: string; userId?: string; callbackData: string; messageId?: number }): Promise<void> { await this.deliverCallback(input); }
  async deliverCallback(input: { chatId: string; userId?: string; callbackData: string; messageId?: number; callbackQueryId?: string }): Promise<void> { await this.shell.handleCallback(input.chatId, input.callbackQueryId ?? `cb_${Date.now()}`, input.callbackData, input.userId ?? this.defaultUserId(input.chatId), input.messageId ?? this.latestActionMessageId(input.chatId)); }
  failNextMessageDelivery(): void { this.sendOutcomes.push("fail"); }
  failNextChatActionDelivery(): void { this.failNextChatAction = true; }
  setMessageDeliverySequence(...outcomes: Array<"pass" | "fail" | "deliver_then_fail">): void { this.sendOutcomes.push(...outcomes); }
  failNextTaskMutationRejection(): void { this.failNextTaskReject = true; }
  failNextReplyMarkupEdit(): void { this.failNextMarkupEdit = true; }
  sentMessages(): SentMessage[] { return this.sent; }
  messageDeliveryAttempts(): Array<Omit<SentMessage, "messageId">> { return [...this.deliveryAttempts]; }
  taskMutationRejectCalls(): string[] { return [...this.taskRejects]; }
  callbackAnswers(): CallbackAnswer[] { return this.callbacks; }
  replyMarkupEditCalls(): ReplyMarkupEdit[] { return this.replyMarkupEdits; }
  sentChatActions(): Array<{ chatId: string; action: "typing" }> { return this.chatActions; }
  voiceDownloadCalls(): string[] { return [...this.voiceDownloads]; }
  transcriptionCalls(): string[] { return [...this.transcriptions]; }
  closedVoiceStreamIds(): string[] { return [...this.closedVoiceStreams]; }
  clear() { this.sent.length = 0; this.callbacks.length = 0; this.replyMarkupEdits.length = 0; this.chatActions.length = 0; this.deliveryAttempts.length = 0; this.taskRejects.length = 0; this.voiceDownloads.length = 0; this.transcriptions.length = 0; this.closedVoiceStreams.length = 0; }
  private latestActionMessageId(chatId: string): number | undefined {
    for (let index = this.sent.length - 1; index >= 0; index--) {
      const message = this.sent[index];
      if (message.chatId === chatId && message.replyMarkup) return message.messageId;
    }
    return undefined;
  }
  private defaultUserId(chatId: string): string { return `user_${chatId}`; }
}
