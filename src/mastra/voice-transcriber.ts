import { OpenAIVoice } from "@mastra/voice-openai";
import type { SpeechToTextPort } from "../application/speech-to-text.js";
import type { SttConfig } from "../runtime/stt-config.js";

const whisperModel = "whisper-1" as const;
const speechModel = "tts-1" as const;
export const defaultOpenAiSttBaseUrl = "https://api.openai.com/v1";

export function openAiVoiceConfig(config: Pick<SttConfig, "apiKey" | "baseUrl">) {
  // OpenAIVoice currently constructs both clients, even for listen()-only use.
  // Configure both explicitly so neither can inherit OPENAI_* LLM credentials.
  const options = { baseURL: config.baseUrl ?? defaultOpenAiSttBaseUrl };
  return {
    speechModel: { name: speechModel, apiKey: config.apiKey, options },
    listeningModel: { name: whisperModel, apiKey: config.apiKey, options },
  };
}

/** Mastra/OpenAI adapter; audio is consumed only for the duration of `listen()`. */
export function createOpenAiSpeechToText(config: Pick<SttConfig, "apiKey" | "baseUrl">): SpeechToTextPort {
  const voice = new OpenAIVoice(openAiVoiceConfig(config));
  return {
    async transcribe({ audio, filetype, signal }) {
      // The package declaration omits "ogg", although Whisper accepts the
      // Telegram OGG/Opus container. The cast is needed only for that stale union.
      // listen() does not expose AbortSignal, so close its input to abort its read.
      signal?.addEventListener("abort", () => (audio as NodeJS.ReadableStream & { destroy: () => void }).destroy(), { once: true });
      const transcript = await voice.listen(audio, { filetype: filetype as "mp3" });
      if (typeof transcript !== "string") throw new Error("STT provider returned a non-text result");
      return transcript;
    },
  };
}
