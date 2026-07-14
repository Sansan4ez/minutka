import { existsSync, readFileSync } from "node:fs";

export const defaultLlmModel = "openai/gpt-5.4-mini";

/**
 * Load the local .env before agent modules read the model configuration.
 * Existing environment variables always take precedence over .env values.
 */
export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;

  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    const index = trimmed.indexOf("=");
    if (!trimmed || trimmed.startsWith("#") || index === -1) continue;

    const key = trimmed.slice(0, index).trim();
    if (!key || process.env[key]) continue;
    process.env[key] = trimmed.slice(index + 1).trim();
  }
}

loadDotEnv();

export function llmModelFromEnv(env: NodeJS.ProcessEnv): string {
  const model = env.LLM_MODEL?.trim();
  return model || defaultLlmModel;
}

/** The single model setting shared by every Mastra agent. */
export const llmModel = llmModelFromEnv(process.env);
