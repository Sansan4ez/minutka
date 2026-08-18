import type { Pool } from "pg";
import { mapPostgresError } from "../../application/persistence-error.js";
import { parseEvaluationCase, type EvaluationCaseRecord, type EvaluationCaseStore } from "../../application/research-evaluation.js";

type Row = { payload: unknown };

export function createPostgresEvaluationCaseStore(pool: Pool): EvaluationCaseStore {
  return {
    async create(input) {
      const record = parseEvaluationCase(input);
      try {
        await pool.query(
          `INSERT INTO minutka_research.evaluation_cases
            (case_id, schema_version, company_id, group_id, subject_key, trace_id, request_id, message_id,
             prompt_version, process_version, taxonomy_version, model, labels, payload, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15)`,
          [record.caseId, record.schemaVersion, record.companyId, record.groupId, record.subjectKey, record.traceId,
            record.requestId, record.messageId, record.promptVersion, record.processVersion, record.taxonomyVersion,
            record.model, JSON.stringify(record.labels), JSON.stringify(record), record.createdAt],
        );
      } catch (error) { throw mapPostgresError(error); }
    },
    async get({ companyId, groupId, caseId }) {
      try {
        const result = await pool.query<Row>(
          "SELECT payload FROM minutka_research.evaluation_cases WHERE company_id=$1 AND group_id=$2 AND case_id=$3",
          [companyId, groupId, caseId],
        );
        return result.rows[0] ? parseEvaluationCase(result.rows[0].payload) : undefined;
      } catch (error) { throw mapPostgresError(error); }
    },
    async list({ companyId, groupId }) {
      try {
        const result = await pool.query<Row>(
          `SELECT payload FROM minutka_research.evaluation_cases
           WHERE company_id=$1 AND group_id=$2 ORDER BY created_at, case_id`,
          [companyId, groupId],
        );
        return result.rows.map(({ payload }) => parseEvaluationCase(payload)) as EvaluationCaseRecord[];
      } catch (error) { throw mapPostgresError(error); }
    },
  };
}
