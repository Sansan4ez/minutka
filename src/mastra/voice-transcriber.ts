import { OpenAIVoice } from "@mastra/voice-openai";
import type { SpeechToTextPort } from "../application/speech-to-text.js";
import type { SttConfig } from "../runtime/stt-config.js";

const whisperModel = "whisper-1" as const;

/** Mastra/OpenAI adapter; audio is consumed only for the duration of `listen()`. */
export function createOpenAiSpeechToText(config: Pick<SttConfig, "apiKey" | "baseUrl">): SpeechToTextPort {
  const voice = new OpenAIVoice({
    listeningModel: {
      name: whisperModel,
      apiKey: config.apiKey,
      ...(config.baseUrl ? { options: { baseURL: config.baseUrl } } : {}),
    },
  });
  return {
    async transcribe({ audio, filetype }) {
      // The installed declaration omits "ogg", while Whisper accepts Telegram's
      // OGG/Opus container at runtime. Its open options index permits it.
      const transcript = await voice.listen(audio, { filetype: filetype as "mp3" });
      if (typeof transcript !== "string") throw new Error("STT provider returned a non-text result");
      return transcript;
    },
  };
}
