import { describe, expect, it } from "vitest";
import { sttConfigFromEnv } from "../../../src/runtime/stt-config.js";
import { defaultOpenAiSttBaseUrl, openAiVoiceConfig } from "../../../src/mastra/voice-transcriber.js";

describe("STT runtime configuration", () => {
  it("uses separate provider-neutral STT credentials", () => {
    expect(sttConfigFromEnv({ STT_API_KEY: "stt-secret", STT_BASE_URL: "https://stt.example/v1" })).toEqual({
      provider: "openai", apiKey: "stt-secret", baseUrl: "https://stt.example/v1",
    });
  });

  it("normalizes the provider and permits polling without voice configuration", () => {
    expect(sttConfigFromEnv({ STT_PROVIDER: " OpenAI ", STT_API_KEY: "key" })).toMatchObject({ provider: "openai" });
    expect(sttConfigFromEnv({})).toBeUndefined();
  });

  it("rejects incomplete, invalid, and unsupported configuration", () => {
    expect(() => sttConfigFromEnv({ STT_BASE_URL: "https://stt.example" })).toThrow("STT_BASE_URL requires STT_API_KEY");
    expect(() => sttConfigFromEnv({ STT_PROVIDER: "other" })).toThrow("Unsupported STT_PROVIDER: other");
    expect(() => sttConfigFromEnv({ STT_API_KEY: "key", STT_BASE_URL: "ftp://stt.example" })).toThrow("STT_BASE_URL");
    expect(() => sttConfigFromEnv({ STT_PROVIDER: "other", STT_API_KEY: "key" })).toThrow("Unsupported STT_PROVIDER: other");
  });

  it("isolates every OpenAI voice client from LLM environment defaults", () => {
    const config = openAiVoiceConfig({ apiKey: "stt-secret" });
    expect(config).toEqual({
      speechModel: { name: "tts-1", apiKey: "stt-secret", options: { baseURL: defaultOpenAiSttBaseUrl } },
      listeningModel: { name: "whisper-1", apiKey: "stt-secret", options: { baseURL: defaultOpenAiSttBaseUrl } },
    });
  });
});
