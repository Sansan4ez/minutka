import { normalizeUsageMonth, type UsageSource, type UsageTotals, type UsageCostPolicy } from "./usage-store.js";

export type GroupUsageTotals = UsageTotals & {
  /** Input-token denominator from rows where the provider reported cached input. */
  cacheReportedInputTokens: number;
  /** cachedInputTokens / cacheReportedInputTokens; null when no row reported cache data. */
  cacheShare: number | null;
};

export type GroupUsageSourceTotals = GroupUsageTotals & { source: UsageSource };
export type ParticipantUsageLimit = { employeeId: string; estimatedCostUsdMicros: number };

export type GroupMonthlyUsage = GroupUsageTotals & {
  companyId: string;
  groupId: string;
  month: string;
  participants: number;
  softLimitUsdMicros: number;
  participantsAboveSoftLimit: ParticipantUsageLimit[];
  participantsAboveSoftLimitCount: number;
  bySource: GroupUsageSourceTotals[];
};

export type GroupUsageStore = {
  getGroupMonthly(input: {
    companyId: string;
    groupId: string;
    month: string;
    softLimitUsdMicros: number;
  }): Promise<GroupMonthlyUsage>;
};

/** Typed operator use-case; transports never query usage or participant stores directly. */
export class GroupUsageReportingService {
  constructor(
    private readonly store: GroupUsageStore,
    private readonly policy: Pick<UsageCostPolicy, "monthlySoftLimitUsdMicros">,
  ) {}

  getMonthly(input: { companyId: string; groupId: string; month: string }): Promise<GroupMonthlyUsage> {
    return this.store.getGroupMonthly({
      companyId: requiredScope(input.companyId, "companyId"),
      groupId: requiredScope(input.groupId, "groupId"),
      month: normalizeUsageMonth(input.month),
      softLimitUsdMicros: this.policy.monthlySoftLimitUsdMicros,
    });
  }
}

export function cacheShare(cachedInputTokens: number, cacheReportedInputTokens: number): number | null {
  return cacheReportedInputTokens === 0 ? null : cachedInputTokens / cacheReportedInputTokens;
}

function requiredScope(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}
