import type { Pool } from "pg";
import { cacheShare, type GroupMonthlyUsage, type GroupUsageSourceTotals, type GroupUsageStore } from "../../application/group-usage-reporting.js";
import { mapPostgresError } from "../../application/persistence-error.js";
import {
  emptyMonthlyUsage,
  emptyUsageTotals,
  isUsageSource,
  normalizeUsageMonth,
  normalizeUsageRecord,
  usageSources,
  type MonthlyUsage,
  type UsageSourceTotals,
  type UsageStore,
  type UsageTotals,
} from "../../application/usage-store.js";

export function createPostgresUsageStore(pool: Pool): UsageStore & GroupUsageStore {
  return {
    async record(input) {
      const normalized = normalizeUsageRecord(input);
      try {
        const inserted = await pool.query(
          `INSERT INTO minutka_private.usage
             (usage_id,user_id,request_id,source,usage_month,input_tokens,output_tokens,total_tokens,cached_input_tokens,estimated_cost_usd_micros,occurred_at)
           VALUES ($1,$2,$3,$4,$5::date,$6,$7,$8,$9,$10,$11::timestamptz)
           ON CONFLICT (request_id,user_id,source) DO NOTHING`,
          [normalized.id, normalized.userId, normalized.requestId, normalized.source, `${normalized.month}-01`, normalized.inputTokens,
            normalized.outputTokens, normalized.totalTokens, normalized.cachedInputTokens ?? null, normalized.estimatedCostUsdMicros, normalized.occurredAt],
        );
        return {
          monthly: await monthly(pool, normalized.userId, normalized.month),
          inserted: (inserted.rowCount ?? 0) > 0,
        };
      } catch (error) { throw mapPostgresError(error); }
    },
    async getMonthly(userId, month) {
      try { return await monthly(pool, userId, normalizeUsageMonth(month)); }
      catch (error) { throw mapPostgresError(error); }
    },
    async getGroupMonthly(input) {
      try { return await groupMonthly(pool, { ...input, month: normalizeUsageMonth(input.month) }); }
      catch (error) { throw mapPostgresError(error); }
    },
  };
}

async function monthly(pool: Pool, userId: string, month: string): Promise<MonthlyUsage> {
  const empty = emptyMonthlyUsage(userId, month);
  // NULL cached_input_tokens means "the provider reported no breakdown". sum()
  // skips those rows, and the separate count keeps them visible as unknown
  // instead of letting them read as reported cache misses.
  const result = await pool.query<{
    source: string; records: string; input_tokens: string; output_tokens: string; total_tokens: string;
    cached_input_tokens: string; cached_input_unknown_records: string; estimated_cost_usd_micros: string;
  }>(
    `SELECT
       source,
       count(*)::text AS records,
       COALESCE(sum(input_tokens),0)::text AS input_tokens,
       COALESCE(sum(output_tokens),0)::text AS output_tokens,
       COALESCE(sum(total_tokens),0)::text AS total_tokens,
       COALESCE(sum(cached_input_tokens),0)::text AS cached_input_tokens,
       count(*) FILTER (WHERE cached_input_tokens IS NULL)::text AS cached_input_unknown_records,
       COALESCE(sum(estimated_cost_usd_micros),0)::text AS estimated_cost_usd_micros
     FROM minutka_private.usage
     WHERE user_id=$1 AND usage_month=$2::date
     GROUP BY source`,
    [empty.userId, `${empty.month}-01`],
  );
  const totalsBySource = new Map<string, UsageTotals>();
  for (const row of result.rows) {
    if (!isUsageSource(row.source)) throw new Error(`unknown usage source: ${row.source}`);
    totalsBySource.set(row.source, {
      inputTokens: safeInteger(row.input_tokens, "input tokens"),
      outputTokens: safeInteger(row.output_tokens, "output tokens"),
      totalTokens: safeInteger(row.total_tokens, "total tokens"),
      estimatedCostUsdMicros: safeInteger(row.estimated_cost_usd_micros, "estimated usage cost"),
      records: safeInteger(row.records, "usage records"),
      cachedInputTokens: safeInteger(row.cached_input_tokens, "cached input tokens"),
      cachedInputUnknownRecords: safeInteger(row.cached_input_unknown_records, "usage records without cached input"),
    });
  }
  const bySource: UsageSourceTotals[] = usageSources
    .filter((source) => totalsBySource.has(source))
    .map((source) => ({ source, ...totalsBySource.get(source)! }));
  return { ...empty, ...bySource.reduce(addTotals, emptyUsageTotals()), bySource };
}

async function groupMonthly(pool: Pool, input: { companyId: string; groupId: string; month: string; softLimitUsdMicros: number }): Promise<GroupMonthlyUsage> {
  const participantCount = await pool.query<{ participants: string }>(
    `SELECT count(*)::text AS participants
     FROM minutka_private.participants
     WHERE company_id=$1 AND group_id=$2`,
    [input.companyId, input.groupId],
  );
  const result = await pool.query<{
    source: string; records: string; input_tokens: string; output_tokens: string; total_tokens: string;
    cached_input_tokens: string; cached_input_unknown_records: string; cache_reported_input_tokens: string; estimated_cost_usd_micros: string;
  }>(
    `SELECT usage.source,
       count(*)::text AS records,
       COALESCE(sum(usage.input_tokens),0)::text AS input_tokens,
       COALESCE(sum(usage.output_tokens),0)::text AS output_tokens,
       COALESCE(sum(usage.total_tokens),0)::text AS total_tokens,
       COALESCE(sum(usage.cached_input_tokens),0)::text AS cached_input_tokens,
       count(*) FILTER (WHERE usage.cached_input_tokens IS NULL)::text AS cached_input_unknown_records,
       COALESCE(sum(usage.input_tokens) FILTER (WHERE usage.cached_input_tokens IS NOT NULL),0)::text AS cache_reported_input_tokens,
       COALESCE(sum(usage.estimated_cost_usd_micros),0)::text AS estimated_cost_usd_micros
     FROM minutka_private.usage usage
     JOIN minutka_private.participants participant ON participant.employee_id=usage.user_id
     WHERE participant.company_id=$1 AND participant.group_id=$2 AND usage.usage_month=$3::date
     GROUP BY usage.source`,
    [input.companyId, input.groupId, `${input.month}-01`],
  );
  const totalsBySource = new Map<string, GroupUsageSourceTotals>();
  for (const row of result.rows) {
    if (!isUsageSource(row.source)) throw new Error(`unknown usage source: ${row.source}`);
    const cachedInputTokens = safeInteger(row.cached_input_tokens, "cached input tokens");
    const cacheReportedInputTokens = safeInteger(row.cache_reported_input_tokens, "cache-reported input tokens");
    totalsBySource.set(row.source, {
      source: row.source,
      inputTokens: safeInteger(row.input_tokens, "input tokens"),
      outputTokens: safeInteger(row.output_tokens, "output tokens"),
      totalTokens: safeInteger(row.total_tokens, "total tokens"),
      estimatedCostUsdMicros: safeInteger(row.estimated_cost_usd_micros, "estimated usage cost"),
      records: safeInteger(row.records, "usage records"),
      cachedInputTokens,
      cachedInputUnknownRecords: safeInteger(row.cached_input_unknown_records, "usage records without cached input"),
      cacheReportedInputTokens,
      cacheShare: cacheShare(cachedInputTokens, cacheReportedInputTokens),
    });
  }
  const bySource = usageSources.filter((source) => totalsBySource.has(source)).map((source) => totalsBySource.get(source)!);
  const totals = bySource.reduce(addGroupTotals, { ...emptyUsageTotals(), cacheReportedInputTokens: 0, cacheShare: null as number | null });
  totals.cacheShare = cacheShare(totals.cachedInputTokens, totals.cacheReportedInputTokens);
  const aboveLimitResult = await pool.query<{ employee_id: string; estimated_cost_usd_micros: string }>(
    `SELECT participant.employee_id, COALESCE(sum(usage.estimated_cost_usd_micros),0)::text AS estimated_cost_usd_micros
     FROM minutka_private.participants participant
     LEFT JOIN minutka_private.usage usage ON usage.user_id=participant.employee_id AND usage.usage_month=$3::date
     WHERE participant.company_id=$1 AND participant.group_id=$2
     GROUP BY participant.employee_id
     HAVING COALESCE(sum(usage.estimated_cost_usd_micros),0) > $4
     ORDER BY participant.employee_id`,
    [input.companyId, input.groupId, `${input.month}-01`, input.softLimitUsdMicros],
  );
  const participantsAboveSoftLimit = aboveLimitResult.rows.map((row) => ({ employeeId: row.employee_id, estimatedCostUsdMicros: safeInteger(row.estimated_cost_usd_micros, "participant estimated usage cost") }));
  return {
    companyId: input.companyId,
    groupId: input.groupId,
    month: input.month,
    participants: safeInteger(participantCount.rows[0]?.participants ?? "0", "participants"),
    softLimitUsdMicros: input.softLimitUsdMicros,
    participantsAboveSoftLimit,
    participantsAboveSoftLimitCount: participantsAboveSoftLimit.length,
    ...totals,
    bySource,
  };
}

function addGroupTotals(left: UsageTotals & { cacheReportedInputTokens: number; cacheShare: number | null }, right: GroupUsageSourceTotals) {
  return { ...addTotals(left, right), cacheReportedInputTokens: left.cacheReportedInputTokens + right.cacheReportedInputTokens, cacheShare: null as number | null };
}

function addTotals(left: UsageTotals, right: UsageTotals): UsageTotals {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    estimatedCostUsdMicros: left.estimatedCostUsdMicros + right.estimatedCostUsdMicros,
    records: left.records + right.records,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cachedInputUnknownRecords: left.cachedInputUnknownRecords + right.cachedInputUnknownRecords,
  };
}

function safeInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${field} exceeds safe integer range`);
  return parsed;
}
