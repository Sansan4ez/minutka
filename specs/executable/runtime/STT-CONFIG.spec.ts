import { describe, expect, it } from "vitest";
import { sttConfigFromEnv } from "../../../src/runtime/stt-config.js";

describe("STT runtime configuration", () => {
  it("uses separate provider-neutral STT credentials", () => {
    expect(sttConfigFromEnv({ STT_API_KEY: "stt-secret", STT_BASE_URL: "https://stt.example/v1" })).toEqual({
      provider: "openai", apiKey: "stt-secret", baseUrl: "https://stt.example/v1",
    });
  });

  it("rejects missing credentials and unsupported endpoint schemes", () => {
    expect(() => sttConfigFromEnv({})).toThrow("STT_API_KEY");
    expect(() => sttConfigFromEnv({ STT_API_KEY: "key", STT_BASE_URL: "ftp://stt.example" })).toThrow("STT_BASE_URL");
  });
});
