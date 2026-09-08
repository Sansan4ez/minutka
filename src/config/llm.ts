import { readDotEnvValue } from "./env.js";

export const defaultLlmModel = "openai/gpt-5.5";
export const defaultLlmReasoningEffort = "high";

export type LlmReasoningEffort = "minimal" | "low" | "medium" | "high";

export function llmReasoningEffortFromEnv(env: NodeJS.ProcessEnv): LlmReasoningEffort {
  const effort = env.LLM_REASONING_EFFORT?.trim();
  if (effort === "minimal" || effort === "low" || effort === "medium" || effort === "high") return effort;
  return defaultLlmReasoningEffort;
}

export const llmReasoningEffort = llmReasoningEffortFromEnv({
  ...process.env,
  LLM_REASONING_EFFORT: process.env.LLM_REASONING_EFFORT ?? readDotEnvValue(".env", "LLM_REASONING_EFFORT"),
});

/** Provider settings shared by every Mastra agent. */
export const llmProviderOptions = {
  openai: {
    reasoningEffort: llmReasoningEffort,
    // Keep a stable cache namespace across owner turns. The owner-specific
    // prefix itself remains the provider's exact-match cache boundary.
    promptCacheKey: "personal-assistant-v1",
    promptCacheRetention: "24h",
    // The local OpenAI-compatible gateway is stateless. This must be explicit
    // so AI SDK resends tool/reasoning content instead of referencing fc_/rs_
    // response items that the gateway did not persist.
    store: false,
  },
} as const;

export function llmModelFromEnv(env: NodeJS.ProcessEnv): string {
  const model = env.LLM_MODEL?.trim();
  return model || defaultLlmModel;
}

/** The single model setting shared by every Mastra agent. */
export const llmModel = llmModelFromEnv({
  ...process.env,
  LLM_MODEL: process.env.LLM_MODEL ?? readDotEnvValue(".env", "LLM_MODEL"),
});

/** Base configuration spread into every Mastra Agent. */
export const llmAgentConfig = {
  model: llmModel,
  defaultOptions: { providerOptions: llmProviderOptions },
} as const;
