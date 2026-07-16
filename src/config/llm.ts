import { readDotEnvValue } from "./env.js";

export const defaultLlmModel = "openai/gpt-5.5";

export function llmModelFromEnv(env: NodeJS.ProcessEnv): string {
  const model = env.LLM_MODEL?.trim();
  return model || defaultLlmModel;
}

/** The single model setting shared by every Mastra agent. */
export const llmModel = llmModelFromEnv({
  ...process.env,
  LLM_MODEL: process.env.LLM_MODEL ?? readDotEnvValue(".env", "LLM_MODEL"),
});
