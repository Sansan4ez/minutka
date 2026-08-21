import type { Participant } from "../domain/employee.js";
import { cacheShare, type GroupUsageSourceTotals, type GroupUsageStore } from "./group-usage-reporting.js";
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
export function createInMemoryUsageStore(
  participants: () => readonly Pick<Participant, "employeeId" | "companyId" | "groupId">[] = () => [],
): UsageStore & GroupUsageStore & { listRecords(): Promise<UsageRecord[]> } {
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
    async getGroupMonthly(input) {
      const month = normalizeUsageMonth(input.month);
      const scopedParticipants = participants().filter((participant) => participant.companyId === input.companyId && participant.groupId === input.groupId);
      const employeeIds = new Set(scopedParticipants.map((participant) => participant.employeeId));
      const scopedRecords = [...records.values()].filter((record) => employeeIds.has(record.userId) && record.month === month);
      const participantCosts = scopedParticipants.map((participant) => ({
        employeeId: participant.employeeId,
        estimatedCostUsdMicros: scopedRecords.filter((record) => record.userId === participant.employeeId).reduce((sum, record) => sum + record.estimatedCostUsdMicros, 0),
      }));
      const aboveLimit = participantCosts.filter(({ estimatedCostUsdMicros }) => estimatedCostUsdMicros > input.softLimitUsdMicros).sort((left, right) => left.employeeId.localeCompare(right.employeeId));
      const bySource: GroupUsageSourceTotals[] = usageSources.map((source) => groupSourceTotals(scopedRecords.filter((record) => record.source === source), source)).filter((totals) => totals.records > 0);
      const totals = groupTotals(scopedRecords);
      return {
        companyId: input.companyId,
        groupId: input.groupId,
        month,
        participants: scopedParticipants.length,
        softLimitUsdMicros: input.softLimitUsdMicros,
        participantsAboveSoftLimit: aboveLimit,
        participantsAboveSoftLimitCount: aboveLimit.length,
        ...totals,
        bySource,
      };
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

function groupTotals(records: UsageRecord[]) {
  const totals = records.reduce(addUsageRecordToTotals, emptyUsageTotals());
  const cacheReportedInputTokens = records.filter((record) => record.cachedInputTokens !== undefined).reduce((sum, record) => sum + record.inputTokens, 0);
  return { ...totals, cacheReportedInputTokens, cacheShare: cacheShare(totals.cachedInputTokens, cacheReportedInputTokens) };
}

function groupSourceTotals(records: UsageRecord[], source: UsageSourceTotals["source"]): GroupUsageSourceTotals {
  return { source, ...groupTotals(records) };
}

function copyRecord(record: UsageRecord): UsageRecord { return { ...record }; }
