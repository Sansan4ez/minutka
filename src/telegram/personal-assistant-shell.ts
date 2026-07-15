import type { AssistantService } from "../application/assistant-service.js";
import type { IngestionService } from "../application/ingestion-service.js";
import type { SpeechToTextPort } from "../application/speech-to-text.js";

export type PersonalAssistantReplyPort = {
  sendMessage(chatId: string, text: string): Promise<void>;
};

/**
 * Telegram adapter for the personal-assistant inbox. It maps transport payloads
 * to typed sources and deliberately delegates all classification and storage to
 * AssistantService/IngestionService.
 */
export function createPersonalAssistantTelegramShell(deps: {
  assistant: Pick<AssistantService, "chat">;
  ingestion: Pick<IngestionService, "captureInboxFile">;
  replyPort: PersonalAssistantReplyPort;
  speechToText?: SpeechToTextPort;
}) {
  async function send(chatId: string, input: { userId: string; text: string; source: { kind: "text"; text: string } | { kind: "blob"; blobKey: string } }) {
    const result = await deps.assistant.chat({ userId: input.userId, threadId: `telegram:${chatId}`, text: input.text, source: input.source });
    await deps.replyPort.sendMessage(chatId, result.response);
  }

  return {
    async handleText(input: { chatId: string; userId: string; text: string }) {
      const text = input.text.trim();
      if (!text) throw new Error("text is required");
      await send(input.chatId, { userId: input.userId, text, source: { kind: "text", text } });
    },
    /** A link is text transport-wise, but named explicitly to make the channel contract clear. */
    async handleLink(input: { chatId: string; userId: string; url: string }) {
      const text = input.url.trim();
      if (!/^https?:\/\//i.test(text)) throw new Error("link must be an http(s) URL");
      await send(input.chatId, { userId: input.userId, text, source: { kind: "text", text } });
    },
    async handleVoice(input: { chatId: string; userId: string; audio: NodeJS.ReadableStream; filetype: string }) {
      if (!deps.speechToText) throw new Error("speech-to-text is unavailable");
      const text = (await deps.speechToText.transcribe({ audio: input.audio, filetype: input.filetype })).trim();
      if (!text) throw new Error("voice transcript is empty");
      await send(input.chatId, { userId: input.userId, text, source: { kind: "text", text } });
    },
    async handlePhoto(input: { chatId: string; userId: string; fileName: string; body: Buffer; contentType: string; caption?: string }) {
      const blob = await deps.ingestion.captureInboxFile({ userId: input.userId, fileName: input.fileName, body: input.body, contentType: input.contentType });
      const text = input.caption?.trim() || `Фото: ${blob.key}`;
      await send(input.chatId, { userId: input.userId, text, source: { kind: "blob", blobKey: blob.key } });
    },
  };
}
