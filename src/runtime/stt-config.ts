export type SttConfig = {
  /** Provider selector is intentionally separate from generic STT credentials. */
  provider: string;
  apiKey: string;
  baseUrl?: string;
};

/**
 * Loads provider-neutral STT credentials. Future providers reuse STT_API_KEY
 * and STT_BASE_URL instead of borrowing the LLM's OPENAI_* environment.
 */
export function sttConfigFromEnv(env: NodeJS.ProcessEnv): SttConfig {
  const provider = (env.STT_PROVIDER ?? "openai").trim().toLowerCase();
  const apiKey = env.STT_API_KEY?.trim();
  const baseUrl = env.STT_BASE_URL?.trim();
  if (!provider) throw new Error("STT_PROVIDER must not be empty");
  if (!apiKey) throw new Error("STT_API_KEY is required when TELEGRAM_MODE=polling");
  if (baseUrl && !/^https?:\/\//.test(baseUrl)) throw new Error("STT_BASE_URL must be an http(s) URL");
  return { provider, apiKey, ...(baseUrl ? { baseUrl } : {}) };
}
