import type { Pool } from "pg";
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

export function createPostgresUsageStore(pool: Pool): UsageStore {
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
