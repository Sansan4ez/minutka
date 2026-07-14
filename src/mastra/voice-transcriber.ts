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
      // Mastra 0.13's declaration omits "ogg", although the OpenAI
      // transcription API accepts Telegram's OGG/Opus container. Keep the
      // actual runtime value instead of pretending it is another format.
      const destroyAudio = () => {
        const destroy = (audio as NodeJS.ReadableStream & { destroy?: () => void }).destroy;
        if (typeof destroy === "function") destroy.call(audio);
      };
      const onAbort = () => destroyAudio();
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        // The installed Mastra declaration is narrower than the provider's
        // runtime/API contract. Localize that compatibility boundary here;
        // the Telegram gateway still supplies the actual "ogg" format.
        const listen = voice.listen.bind(voice) as (input: NodeJS.ReadableStream, options?: { filetype?: string }) => Promise<string>;
        const transcript = await listen(audio, { filetype });
        if (typeof transcript !== "string") throw new Error("STT provider returned a non-text result");
        return transcript;
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
