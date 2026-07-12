import { safeAuditMetadata, type AuditEventRecord, type AuditEventStore } from "../../application/audit-event-store.js";
import { mapPostgresError } from "../../application/persistence-error.js";
import type { Pool } from "pg";

type Row = {
  event_id: string;
  request_id: string;
  event_type: AuditEventRecord["type"];
  employee_id: string | null;
  thread_id: string | null;
  message_id: string | null;
  metadata: AuditEventRecord["metadata"];
  occurred_at: Date;
};
const event = (row: Row): AuditEventRecord => ({
  id: row.event_id,
  requestId: row.request_id,
  type: row.event_type,
  ...(row.employee_id ? { employeeId: row.employee_id } : {}),
  ...(row.thread_id ? { threadId: row.thread_id } : {}),
  ...(row.message_id ? { messageId: row.message_id } : {}),
  metadata: row.metadata,
  occurredAt: row.occurred_at.toISOString(),
});

export function createPostgresAuditEventStore(pool: Pool): AuditEventStore {
  return {
    async append(input) {
      try {
        await pool.query(
          `INSERT INTO minutka_audit.events
            (event_id,request_id,event_type,employee_id,thread_id,message_id,metadata,occurred_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
          [input.id, input.requestId, input.type, input.employeeId ?? null, input.threadId ?? null, input.messageId ?? null, JSON.stringify(safeAuditMetadata(input.type, input.metadata)), input.occurredAt],
        );
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async listCurrent({ requestId, limit }) {
      try {
        const result = await pool.query<Row>(
          "SELECT * FROM minutka_audit.events WHERE request_id=$1 ORDER BY occurred_at ASC, event_id ASC LIMIT $2",
          [requestId, Math.max(0, limit)],
        );
        return result.rows.map(event);
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async listRecent({ employeeId, threadId, limit }) {
      try {
        const result = await pool.query<Row>(
          `SELECT * FROM minutka_audit.events
           WHERE employee_id=$1${threadId ? " AND thread_id=$2" : ""}
           ORDER BY occurred_at DESC, event_id DESC LIMIT $${threadId ? 3 : 2}`,
          threadId ? [employeeId, threadId, Math.max(0, limit)] : [employeeId, Math.max(0, limit)],
        );
        return result.rows.reverse().map(event);
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
  };
}
