import { assertUserId } from "./document-store.js";

/**
 * Which LLM call of an owner turn produced a usage row. A turn runs several
 * calls, so a row is "one call of one turn", not "one turn"; the source is part
 * of the deduplication key and answers where the money actually went.
 */
export const usageSources = ["chat", "onboarding", "summarization", "guard"] as const;
export type UsageSource = (typeof usageSources)[number];

export function isUsageSource(value: string): value is UsageSource {
  return (usageSources as readonly string[]).includes(value);
}

export type ModelTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Number of provider LLM steps aggregated into this call. */
  llmSteps?: number;
  /**
   * Input tokens served from the provider prompt cache. `undefined` means the
   * provider reported no breakdown; it is never normalized to zero, because
   * "unknown" and "cache miss" support different cost conclusions.
   */
  cachedInputTokens?: number;
};

/** Metadata-only usage entry. Raw prompts and model responses are not part of this boundary. */
export type UsageRecord = ModelTokenUsage & {
  id: string;
  userId: string;
  requestId: string;
  source: UsageSource;
  month: string;
  estimatedCostUsdMicros: number;
  occurredAt: string;
};

export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsdMicros: number;
  records: number;
  /** Summed over the rows whose provider reported a cache breakdown. */
  cachedInputTokens: number;
  /** Rows without a reported breakdown. They stay unknown instead of counting as cache misses. */
  cachedInputUnknownRecords: number;
};

export type UsageSourceTotals = UsageTotals & { source: UsageSource };

export type MonthlyUsage = UsageTotals & {
  userId: string;
  month: string;
  /** The same month split by source, in canonical order. Sources without rows are omitted. */
  bySource: UsageSourceTotals[];
};

/**
 * `inserted` distinguishes a stored row from a deduplicated replay, so callers
 * can tell an actual soft-limit crossing from a repeated write.
 */
export type UsageRecordResult = { monthly: MonthlyUsage; inserted: boolean };

export type UsageCostPolicy = {
  monthlySoftLimitUsdMicros: number;
  inputUsdMicrosPerMillionTokens: number;
  cachedInputUsdMicrosPerMillionTokens: number;
  outputUsdMicrosPerMillionTokens: number;
};

export interface UsageStore {
  record(input: UsageRecord): Promise<UsageRecordResult>;
  getMonthly(userId: string, month: string): Promise<MonthlyUsage>;
}

export function usageMonth(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) throw new Error("usage timestamp must be valid");
  return date.toISOString().slice(0, 7);
}

export function normalizeModelTokenUsage(usage: ModelTokenUsage): ModelTokenUsage {
  const inputTokens = tokenCount(usage.inputTokens, "input tokens");
  const outputTokens = tokenCount(usage.outputTokens, "output tokens");
  const totalTokens = tokenCount(usage.totalTokens, "total tokens");
  const llmSteps = usage.llmSteps === undefined ? undefined : positiveSafeInteger(usage.llmSteps, "LLM steps");
  const cachedInputTokens = usage.cachedInputTokens === undefined ? undefined : tokenCount(usage.cachedInputTokens, "cached input tokens");
  if (cachedInputTokens !== undefined && cachedInputTokens > inputTokens) throw new Error("cached input tokens must not exceed input tokens");
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(llmSteps === undefined ? {} : { llmSteps }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
  };
}

/**
 * Cached input is billed separately, so only the uncached remainder is charged
 * at the full input rate. When the provider reported no cache breakdown the
 * whole input is charged at the full rate: an unreported hit is never assumed.
 */
export function estimateUsageCostUsdMicros(usage: ModelTokenUsage, policy: UsageCostPolicy): number {
  const normalized = normalizeModelTokenUsage(usage);
  const inputRate = nonNegativeSafeInteger(policy.inputUsdMicrosPerMillionTokens, "input token price");
  const cachedInputRate = nonNegativeSafeInteger(policy.cachedInputUsdMicrosPerMillionTokens, "cached input token price");
  const outputRate = nonNegativeSafeInteger(policy.outputUsdMicrosPerMillionTokens, "output token price");
  const cachedInputTokens = normalized.cachedInputTokens ?? 0;
  return roundedMillionth(normalized.inputTokens - cachedInputTokens, inputRate)
    + roundedMillionth(cachedInputTokens, cachedInputRate)
    + roundedMillionth(normalized.outputTokens, outputRate);
}

export function emptyUsageTotals(): UsageTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsdMicros: 0,
    records: 0,
    cachedInputTokens: 0,
    cachedInputUnknownRecords: 0,
  };
}

export function emptyMonthlyUsage(userId: string, month: string): MonthlyUsage {
  return {
    userId: assertUserId(userId),
    month: normalizeUsageMonth(month),
    ...emptyUsageTotals(),
    bySource: [],
  };
}

export function addUsageRecordToTotals(totals: UsageTotals, record: UsageRecord): UsageTotals {
  return {
    inputTokens: totals.inputTokens + record.inputTokens,
    outputTokens: totals.outputTokens + record.outputTokens,
    totalTokens: totals.totalTokens + record.totalTokens,
    estimatedCostUsdMicros: totals.estimatedCostUsdMicros + record.estimatedCostUsdMicros,
    records: totals.records + 1,
    cachedInputTokens: totals.cachedInputTokens + (record.cachedInputTokens ?? 0),
    cachedInputUnknownRecords: totals.cachedInputUnknownRecords + (record.cachedInputTokens === undefined ? 1 : 0),
  };
}

export function normalizeUsageRecord(input: UsageRecord): UsageRecord {
  const id = requiredText(input.id, "usage id");
  const requestId = requiredText(input.requestId, "request id");
  const source = requiredText(input.source, "usage source");
  if (!isUsageSource(source)) throw new Error(`unknown usage source: ${source}`);
  const occurredAt = new Date(input.occurredAt);
  if (Number.isNaN(occurredAt.valueOf())) throw new Error("usage occurredAt must be valid");
  const month = normalizeUsageMonth(input.month);
  if (month !== usageMonth(occurredAt.toISOString())) throw new Error("usage month must match occurredAt");
  return {
    id,
    userId: assertUserId(input.userId),
    requestId,
    source,
    month,
    ...normalizeModelTokenUsage(input),
    estimatedCostUsdMicros: nonNegativeSafeInteger(input.estimatedCostUsdMicros, "estimated usage cost"),
    occurredAt: occurredAt.toISOString(),
  };
}

export function normalizeUsageMonth(month: string): string {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/u.test(month)) throw new Error("usage month must use YYYY-MM");
  return month;
}

function roundedMillionth(tokens: number, usdMicrosPerMillionTokens: number): number {
  const numerator = BigInt(tokens) * BigInt(usdMicrosPerMillionTokens);
  const rounded = (numerator + 500_000n) / 1_000_000n;
  const result = Number(rounded);
  if (!Number.isSafeInteger(result)) throw new Error("estimated usage cost exceeds safe integer range");
  return result;
}

function tokenCount(value: number, field: string): number {
  return nonNegativeSafeInteger(value, field);
}

function positiveSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive safe integer`);
  return value;
}

function nonNegativeSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer`);
  return value;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}
