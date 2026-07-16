import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDotEnv, readDotEnvValue } from "../../../src/config/env.js";
import { defaultLlmModel, llmAgentConfig, llmModel, llmModelFromEnv, llmProviderOptions } from "../../../src/config/llm.js";
import { personalAssistantAgent } from "../../../src/mastra/agents/personal-assistant-agent.js";
import { onboardingProfileExtractorAgent } from "../../../src/mastra/agents/onboarding-profile-extractor-agent.js";
import { requestIntegrityAgent } from "../../../src/mastra/agents/request-integrity-agent.js";

describe("LLM runtime configuration", () => {
  it("uses the configured model and falls back when it is absent or blank", () => {
    expect(llmModelFromEnv({ LLM_MODEL: "openai/custom-model" })).toBe("openai/custom-model");
    expect(llmModelFromEnv({})).toBe(defaultLlmModel);
    expect(llmModelFromEnv({ LLM_MODEL: "  " })).toBe(defaultLlmModel);
  });

  it("keeps an explicitly supplied environment value authoritative", () => {
    expect(llmModelFromEnv({ LLM_MODEL: "openai/from-environment" })).toBe("openai/from-environment");
  });

  it("reads the model without importing unrelated .env values", () => {
    const directory = mkdtempSync(join(tmpdir(), "time-agent-env-"));
    const path = join(directory, ".env");
    const secretKey = "TIME_AGENT_TEST_UNRELATED_SECRET";
    const previous = process.env[secretKey];

    try {
      writeFileSync(path, `LLM_MODEL=openai/from-file\n${secretKey}=must-not-leak\n`);
      delete process.env[secretKey];

      expect(readDotEnvValue(path, "LLM_MODEL")).toBe("openai/from-file");
      expect(process.env[secretKey]).toBeUndefined();
    } finally {
      if (previous === undefined) delete process.env[secretKey];
      else process.env[secretKey] = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("loads only missing variables and preserves explicitly empty values", () => {
    const directory = mkdtempSync(join(tmpdir(), "time-agent-env-"));
    const path = join(directory, ".env");
    const key = "TIME_AGENT_TEST_ENV";
    const emptyKey = "TIME_AGENT_TEST_EMPTY_ENV";
    const missingKey = "TIME_AGENT_TEST_MISSING_ENV";
    const previous = { [key]: process.env[key], [emptyKey]: process.env[emptyKey], [missingKey]: process.env[missingKey] };

    try {
      writeFileSync(path, `${key}=from-file\n${emptyKey}=from-file\n${missingKey}=from-file\n`);
      process.env[key] = "from-process";
      process.env[emptyKey] = "";
      delete process.env[missingKey];

      loadDotEnv(path);

      expect(process.env[key]).toBe("from-process");
      expect(process.env[emptyKey]).toBe("");
      expect(process.env[missingKey]).toBe("from-file");
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("applies one model to every production Mastra agent", () => {
    expect([
      personalAssistantAgent,
      onboardingProfileExtractorAgent,
      requestIntegrityAgent,
    ].map((agent) => agent.model)).toEqual([
      llmModel,
      llmModel,
      llmModel,
    ]);
  });

  it("keeps the accepted OpenAI reasoning configuration explicit", async () => {
    expect(llmProviderOptions).toEqual({ openai: { reasoningEffort: "high" } });
    expect(llmAgentConfig).toEqual({ model: llmModel, defaultOptions: { providerOptions: llmProviderOptions } });
    for (const agent of [personalAssistantAgent, onboardingProfileExtractorAgent, requestIntegrityAgent]) {
      expect(await agent.getDefaultOptions()).toMatchObject({ providerOptions: llmProviderOptions });
    }
  });
});
