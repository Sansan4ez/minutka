import { emptyMonthlyUsage, normalizeUsageRecord, normalizeUsageMonth, type MonthlyUsage, type UsageRecord, type UsageStore } from "./usage-store.js";

/** Hermetic metadata-only adapter for usage executable specs. */
export function createInMemoryUsageStore(): UsageStore & { listRecords(): Promise<UsageRecord[]> } {
  const records = new Map<string, UsageRecord>();

  return {
    async record(input) {
      const normalized = normalizeUsageRecord(input);
      const key = `${normalized.userId}\u0000${normalized.requestId}`;
      const existing = records.get(key);
      if (existing && !sameRecord(existing, normalized)) throw new Error("usage request conflict");
      if (!existing) records.set(key, normalized);
      return aggregate([...records.values()], normalized.userId, normalized.month);
    },
    async getMonthly(userId, month) {
      return aggregate([...records.values()], userId, normalizeUsageMonth(month));
    },
    async listRecords() {
      return [...records.values()].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id)).map(copyRecord);
    },
  };
}

function aggregate(records: UsageRecord[], userId: string, month: string): MonthlyUsage {
  return records
    .filter((record) => record.userId === userId && record.month === month)
    .reduce<MonthlyUsage>((total, record) => ({
      ...total,
      inputTokens: total.inputTokens + record.inputTokens,
      outputTokens: total.outputTokens + record.outputTokens,
      totalTokens: total.totalTokens + record.totalTokens,
      estimatedCostUsdMicros: total.estimatedCostUsdMicros + record.estimatedCostUsdMicros,
    }), emptyMonthlyUsage(userId, month));
}

function sameRecord(left: UsageRecord, right: UsageRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function copyRecord(record: UsageRecord): UsageRecord { return { ...record }; }
