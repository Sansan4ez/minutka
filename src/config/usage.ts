import type { UsageCostPolicy } from "../application/usage-store.js";

export const usageMonthlySoftLimitEnvName = "ASSISTANT_USAGE_MONTHLY_SOFT_LIMIT_USD";
export const usageInputPriceEnvName = "ASSISTANT_USAGE_INPUT_USD_PER_MILLION_TOKENS";
export const usageOutputPriceEnvName = "ASSISTANT_USAGE_OUTPUT_USD_PER_MILLION_TOKENS";

/** Pilot defaults for openai/gpt-5.5; deployments can pin updated provider pricing. */
export const defaultUsageCostPolicy: UsageCostPolicy = {
  monthlySoftLimitUsdMicros: 20_000_000,
  inputUsdMicrosPerMillionTokens: 2_500_000,
  outputUsdMicrosPerMillionTokens: 15_000_000,
};

export function usageCostPolicyFromEnv(env: NodeJS.ProcessEnv): UsageCostPolicy {
  return {
    monthlySoftLimitUsdMicros: parseUsd(env[usageMonthlySoftLimitEnvName], defaultUsageCostPolicy.monthlySoftLimitUsdMicros, usageMonthlySoftLimitEnvName, false),
    inputUsdMicrosPerMillionTokens: parseUsd(env[usageInputPriceEnvName], defaultUsageCostPolicy.inputUsdMicrosPerMillionTokens, usageInputPriceEnvName, true),
    outputUsdMicrosPerMillionTokens: parseUsd(env[usageOutputPriceEnvName], defaultUsageCostPolicy.outputUsdMicrosPerMillionTokens, usageOutputPriceEnvName, true),
  };
}

function parseUsd(raw: string | undefined, fallbackUsdMicros: number, name: string, allowZero: boolean): number {
  if (raw === undefined || raw.trim() === "") return fallbackUsdMicros;
  const normalized = raw.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u.test(normalized)) throw new Error(`${name} must be a USD amount with up to 6 decimal places`);
  const [whole, fraction = ""] = normalized.split(".");
  const usdMicros = Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0"));
  if (!Number.isSafeInteger(usdMicros) || usdMicros < 0 || (!allowZero && usdMicros === 0)) {
    throw new Error(`${name} must be a ${allowZero ? "non-negative" : "positive"} safe USD amount`);
  }
  return usdMicros;
}
