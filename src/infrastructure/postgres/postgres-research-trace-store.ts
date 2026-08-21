import type { Pool } from "pg";
import { mapPostgresError } from "../../application/persistence-error.js";
import {
  parseResearchTrace,
  sanitizeResearchTrace,
  type ResearchTraceRecord,
  type ResearchTraceStore,
} from "../../application/research-trace-store.js";

type Row = { payload: unknown };

export function createPostgresResearchTraceStore(pool: Pool): ResearchTraceStore {
  return {
    async append(input) {
      const trace = sanitizeResearchTrace(input);
      try {
        await pool.query(
          `INSERT INTO minutka_research.traces
            (trace_id, schema_version, request_id, message_id, company_id, group_id, subject_key,
             status, prompt_version, process_version, taxonomy_version, model, sampling_rate,
             started_at, completed_at, payload)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)`,
          [
            trace.traceId,
            trace.schemaVersion,
            trace.requestId,
            trace.messageId,
            trace.companyId,
            trace.groupId,
            trace.subjectKey,
            trace.status,
            trace.promptVersion,
            trace.processVersion,
            trace.taxonomyVersion,
            trace.model,
            trace.samplingRate,
            trace.startedAt,
            trace.completedAt,
            JSON.stringify(trace),
          ],
        );
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async list({ companyId, groupId, subjectKey, traceId, startedFrom, startedTo, limit = 1_000 }) {
      try {
        const result = await pool.query<Row>(
          `SELECT payload
           FROM minutka_research.traces
           WHERE company_id=$1 AND group_id=$2
             AND ($3::text IS NULL OR subject_key::text = $3)
             AND ($4::text IS NULL OR trace_id=$4)
             AND ($5::timestamptz IS NULL OR started_at >= $5)
             AND ($6::timestamptz IS NULL OR started_at <= $6)
           ORDER BY started_at ASC, trace_id ASC
           LIMIT $7`,
          [companyId, groupId, subjectKey ?? null, traceId ?? null, startedFrom ?? null, startedTo ?? null, Math.max(0, limit)],
        );
        return result.rows.map(({ payload }) => parseResearchTrace(payload)) as ResearchTraceRecord[];
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
    async get({ companyId, groupId, traceId }) {
      try {
        const result = await pool.query<Row>(
          "SELECT payload FROM minutka_research.traces WHERE company_id=$1 AND group_id=$2 AND trace_id=$3",
          [companyId, groupId, traceId],
        );
        return result.rows[0] ? parseResearchTrace(result.rows[0].payload) : undefined;
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
  };
}
