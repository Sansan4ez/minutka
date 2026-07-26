import type { ThreadSummary, ThreadSummaryStore } from "../../application/thread-summary-store.js";
import { mapPostgresError } from "../../application/persistence-error.js";
import type { Pool } from "pg";

type Row = {
  employee_id: string;
  thread_id: string;
  summary_text: string;
  watermark_from_message_id: string;
  watermark_through_message_id: string;
  updated_at: Date;
};

export function createPostgresThreadSummaryStore(pool: Pool): ThreadSummaryStore {
  return {
    async get({ employeeId, threadId }) {
      try {
        const result = await pool.query<Row>(
          `SELECT employee_id, thread_id, summary_text, watermark_from_message_id,
                  watermark_through_message_id, updated_at
           FROM minutka_private.thread_summaries
           WHERE employee_id=$1 AND thread_id=$2`,
          [employeeId, threadId],
        );
        return result.rows[0] ? restore(result.rows[0]) : undefined;
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async save(summary) {
      try {
        await pool.query(
          `INSERT INTO minutka_private.thread_summaries
             (employee_id, thread_id, summary_text, watermark_from_message_id,
              watermark_through_message_id, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (employee_id, thread_id) DO UPDATE SET
             summary_text=EXCLUDED.summary_text,
             watermark_from_message_id=EXCLUDED.watermark_from_message_id,
             watermark_through_message_id=EXCLUDED.watermark_through_message_id,
             updated_at=EXCLUDED.updated_at`,
          [
            summary.employeeId,
            summary.threadId,
            summary.text,
            summary.watermark.fromMessageId,
            summary.watermark.throughMessageId,
            summary.updatedAt,
          ],
        );
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
  };
}

function restore(row: Row): ThreadSummary {
  return {
    employeeId: row.employee_id,
    threadId: row.thread_id,
    text: row.summary_text,
    watermark: {
      fromMessageId: row.watermark_from_message_id,
      throughMessageId: row.watermark_through_message_id,
    },
    updatedAt: row.updated_at.toISOString(),
  };
}
