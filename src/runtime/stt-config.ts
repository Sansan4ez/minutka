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
export function sttConfigFromEnv(env: NodeJS.ProcessEnv): SttConfig | undefined {
  const provider = (env.STT_PROVIDER ?? "openai").trim().toLowerCase();
  const apiKey = env.STT_API_KEY?.trim();
  const baseUrl = env.STT_BASE_URL?.trim();
  if (!provider) throw new Error("STT_PROVIDER must not be empty");
  if (!apiKey) {
    if (baseUrl) throw new Error("STT_BASE_URL requires STT_API_KEY");
    if (provider !== "openai") throw new Error(`Unsupported STT_PROVIDER: ${provider}`);
    return undefined;
  }
  if (provider !== "openai") throw new Error(`Unsupported STT_PROVIDER: ${provider}`);
  if (baseUrl) {
    try {
      const url = new URL(baseUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    } catch {
      throw new Error("STT_BASE_URL must be an http(s) URL");
    }
  }
  return { provider, apiKey, ...(baseUrl ? { baseUrl } : {}) };
}
