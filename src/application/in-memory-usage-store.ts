import {
  addUsageRecordToTotals,
  emptyMonthlyUsage,
  emptyUsageTotals,
  normalizeUsageRecord,
  normalizeUsageMonth,
  usageSources,
  type MonthlyUsage,
  type UsageRecord,
  type UsageSourceTotals,
  type UsageStore,
} from "./usage-store.js";

/** Hermetic metadata-only adapter for usage executable specs. */
export function createInMemoryUsageStore(): UsageStore & { listRecords(): Promise<UsageRecord[]> } {
  const records = new Map<string, UsageRecord>();

  return {
    async record(input) {
      const normalized = normalizeUsageRecord(input);
      // The key mirrors the durable primary key: one row per (turn, source).
      const key = `${normalized.userId}\u0000${normalized.requestId}\u0000${normalized.source}`;
      const existing = records.get(key);
      if (!existing) records.set(key, normalized);
      return {
        monthly: aggregate([...records.values()], normalized.userId, normalized.month),
        inserted: !existing,
      };
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
  const owned = records.filter((record) => record.userId === userId && record.month === month);
  const bySource: UsageSourceTotals[] = usageSources
    .map((source) => ({ source, ...owned.filter((record) => record.source === source).reduce(addUsageRecordToTotals, emptyUsageTotals()) }))
    .filter((totals) => totals.records > 0);
  return {
    ...emptyMonthlyUsage(userId, month),
    ...owned.reduce(addUsageRecordToTotals, emptyUsageTotals()),
    bySource,
  };
}

function copyRecord(record: UsageRecord): UsageRecord { return { ...record }; }
