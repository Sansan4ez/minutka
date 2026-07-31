import type { Pool } from "pg";
import { mapPostgresError } from "../../application/persistence-error.js";
import { emptyMonthlyUsage, normalizeUsageMonth, normalizeUsageRecord, type MonthlyUsage, type UsageStore } from "../../application/usage-store.js";

export function createPostgresUsageStore(pool: Pool): UsageStore {
  return {
    async record(input) {
      const normalized = normalizeUsageRecord(input);
      try {
        await pool.query(
          `INSERT INTO minutka_private.usage
             (usage_id,user_id,request_id,usage_month,input_tokens,output_tokens,total_tokens,estimated_cost_usd_micros,occurred_at)
           VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8,$9::timestamptz)
           ON CONFLICT (request_id,user_id) DO NOTHING`,
          [normalized.id, normalized.userId, normalized.requestId, `${normalized.month}-01`, normalized.inputTokens,
            normalized.outputTokens, normalized.totalTokens, normalized.estimatedCostUsdMicros, normalized.occurredAt],
        );
        return await monthly(pool, normalized.userId, normalized.month);
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
  const result = await pool.query<{
    input_tokens: string; output_tokens: string; total_tokens: string; estimated_cost_usd_micros: string;
  }>(
    `SELECT
       COALESCE(sum(input_tokens),0)::text AS input_tokens,
       COALESCE(sum(output_tokens),0)::text AS output_tokens,
       COALESCE(sum(total_tokens),0)::text AS total_tokens,
       COALESCE(sum(estimated_cost_usd_micros),0)::text AS estimated_cost_usd_micros
     FROM minutka_private.usage
     WHERE user_id=$1 AND usage_month=$2::date`,
    [empty.userId, `${empty.month}-01`],
  );
  const row = result.rows[0];
  if (!row) return empty;
  return {
    ...empty,
    inputTokens: safeInteger(row.input_tokens, "input tokens"),
    outputTokens: safeInteger(row.output_tokens, "output tokens"),
    totalTokens: safeInteger(row.total_tokens, "total tokens"),
    estimatedCostUsdMicros: safeInteger(row.estimated_cost_usd_micros, "estimated usage cost"),
  };
}

function safeInteger(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${field} exceeds safe integer range`);
  return parsed;
}
