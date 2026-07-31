import { assertUserId } from "./document-store.js";

export type ModelTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

/** Metadata-only usage entry. Raw prompts and model responses are not part of this boundary. */
export type UsageRecord = ModelTokenUsage & {
  id: string;
  userId: string;
  requestId: string;
  month: string;
  estimatedCostUsdMicros: number;
  occurredAt: string;
};

export type MonthlyUsage = ModelTokenUsage & {
  userId: string;
  month: string;
  estimatedCostUsdMicros: number;
};

export type UsageCostPolicy = {
  monthlySoftLimitUsdMicros: number;
  inputUsdMicrosPerMillionTokens: number;
  outputUsdMicrosPerMillionTokens: number;
};

export interface UsageStore {
  record(input: UsageRecord): Promise<MonthlyUsage>;
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
  return { inputTokens, outputTokens, totalTokens };
}

export function estimateUsageCostUsdMicros(usage: ModelTokenUsage, policy: UsageCostPolicy): number {
  const normalized = normalizeModelTokenUsage(usage);
  const inputRate = nonNegativeSafeInteger(policy.inputUsdMicrosPerMillionTokens, "input token price");
  const outputRate = nonNegativeSafeInteger(policy.outputUsdMicrosPerMillionTokens, "output token price");
  return roundedMillionth(normalized.inputTokens, inputRate) + roundedMillionth(normalized.outputTokens, outputRate);
}

export function emptyMonthlyUsage(userId: string, month: string): MonthlyUsage {
  return {
    userId: assertUserId(userId),
    month: normalizeUsageMonth(month),
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    estimatedCostUsdMicros: 0,
  };
}

export function normalizeUsageRecord(input: UsageRecord): UsageRecord {
  const id = requiredText(input.id, "usage id");
  const requestId = requiredText(input.requestId, "request id");
  const occurredAt = new Date(input.occurredAt);
  if (Number.isNaN(occurredAt.valueOf())) throw new Error("usage occurredAt must be valid");
  const month = normalizeUsageMonth(input.month);
  if (month !== usageMonth(occurredAt.toISOString())) throw new Error("usage month must match occurredAt");
  return {
    id,
    userId: assertUserId(input.userId),
    requestId,
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

function nonNegativeSafeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field} must be a non-negative safe integer`);
  return value;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}
