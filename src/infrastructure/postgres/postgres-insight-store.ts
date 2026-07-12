import { z } from "zod";
import type { InsightStore } from "../../application/insight-store.js";
import { mapPostgresError } from "../../application/persistence-error.js";
import type { StructuredInsight } from "../../domain/insights.js";
import type { Pool } from "pg";
import { withTransaction } from "./postgres-pool.js";

const baseInsight = z.strictObject({
  id: z.string().min(1),
  employeeId: z.string().min(1),
  threadId: z.string().min(1),
  sourceMessageId: z.string().min(1),
  label: z.string().min(1),
  confidence: z.enum(["low", "medium", "high"]),
  createdAt: z.string().min(1),
});
const structuredInsight = z.discriminatedUnion("kind", [
  baseInsight.extend({ kind: z.literal("task_category"), category: z.enum(["planning", "reporting", "meetings", "coordination", "communication", "admin", "focus_work", "unknown"]) }),
  baseInsight.extend({ kind: z.literal("routine_pattern"), patternType: z.enum(["meeting_overload", "context_switching", "manual_reporting", "coordination_overhead", "waiting_for_input", "unclear_priority", "other"]), interferesWith: z.string().min(1).optional() }),
  baseInsight.extend({ kind: z.literal("energy_stress_marker"), marker: z.enum(["overload", "fatigue", "frustration", "focus_loss", "blocked_progress", "neutral"]), intensity: z.enum(["low", "medium", "high"]) }),
  baseInsight.extend({ kind: z.literal("automation_candidate"), candidateType: z.enum(["report_generation", "meeting_reduction", "async_status_update", "task_routing", "template_or_checklist", "data_entry_reduction", "other"]), rationale: z.string().min(1) }),
]);
type Row = {
  insight_id: string;
  employee_id: string;
  thread_id: string;
  source_message_id: string;
  kind: string;
  label: string;
  confidence: string;
  payload: unknown;
  created_at: Date;
};

function restoreInsight(row: Row): StructuredInsight {
  const payload = typeof row.payload === "object" && row.payload !== null ? row.payload : {};
  // Column values are authoritative identity and classification fields.
  return structuredInsight.parse({
    ...payload,
    id: row.insight_id,
    employeeId: row.employee_id,
    threadId: row.thread_id,
    sourceMessageId: row.source_message_id,
    kind: row.kind,
    label: row.label,
    confidence: row.confidence,
    createdAt: row.created_at.toISOString(),
  });
}

export function createPostgresInsightStore(pool: Pool): InsightStore {
  return {
    async saveInsights(insights) {
      if (!insights.length) return;
      try {
        await withTransaction(pool, async (client) => {
          for (const insight of insights) {
            const { id, employeeId, threadId, sourceMessageId, kind, label, confidence, createdAt, ...payload } = insight;
            await client.query(
              `INSERT INTO minutka_private.insights
                (insight_id,employee_id,thread_id,source_message_id,kind,label,confidence,payload,created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
               ON CONFLICT (insight_id) DO NOTHING`,
              [id, employeeId, threadId, sourceMessageId, kind, label, confidence, JSON.stringify(payload), createdAt],
            );
          }
        });
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async listInsights(input) {
      const clauses: string[] = [];
      const params: Array<string | number> = [];
      if (input.employeeId) { params.push(input.employeeId); clauses.push(`employee_id=$${params.length}`); }
      if (input.threadId) { params.push(input.threadId); clauses.push(`thread_id=$${params.length}`); }
      if (input.kind) { params.push(input.kind); clauses.push(`kind=$${params.length}`); }
      const limit = Math.max(0, input.limit ?? 10_000);
      params.push(limit);
      try {
        const result = await pool.query<Row>(
          `SELECT * FROM (
             SELECT * FROM minutka_private.insights${clauses.length ? ` WHERE ${clauses.join(" AND ")}` : ""}
             ORDER BY created_at DESC, insight_id DESC LIMIT $${params.length}
           ) recent ORDER BY created_at ASC, insight_id ASC`,
          params,
        );
        const insights: StructuredInsight[] = [];
        for (const row of result.rows) {
          try {
            insights.push(restoreInsight(row));
          } catch {
            // Corrupt historic JSON must not make otherwise valid employee
            // insights unavailable. Do not log the row or its payload.
            console.warn("Skipped invalid persisted insight.");
          }
        }
        return insights;
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
  };
}
