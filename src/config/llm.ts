import { readDotEnvValue } from "./env.js";

export const defaultLlmModel = "openai/gpt-5.5";

/** Provider settings shared by every Mastra agent. */
export const llmProviderOptions = {
  openai: { reasoningEffort: "high" },
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
