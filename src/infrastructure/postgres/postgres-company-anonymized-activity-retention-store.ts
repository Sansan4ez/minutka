import type { Pool, PoolClient } from "pg";
import {
  CompanyAnonymizedActivityRetentionMismatchError,
  type CompanyAnonymizedActivityRetentionStore,
} from "../../application/company-anonymized-activity-retention.js";
import { mapPostgresError } from "../../application/persistence-error.js";

export function createPostgresCompanyAnonymizedActivityRetentionStore(
  pool: Pool,
): CompanyAnonymizedActivityRetentionStore {
  return {
    async countByCompany(companyId) {
      try {
        const result = await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM minutka_reporting.anonymized_activities WHERE company_id = $1",
          [companyId],
        );
        return result.rows[0]?.count ?? 0;
      } catch (error) {
        throw mapPostgresError(error);
      }
    },

    async deleteByCompany(companyId, expectedRows) {
      let client: PoolClient | undefined;
      try {
        client = await pool.connect();
        const transaction = client;
        await transaction.query("BEGIN");
        const result = await transaction.query(
          "DELETE FROM minutka_reporting.anonymized_activities WHERE company_id = $1",
          [companyId],
        );
        const deletedRows = result.rowCount ?? 0;
        if (deletedRows !== expectedRows) {
          await transaction.query("ROLLBACK");
          throw new CompanyAnonymizedActivityRetentionMismatchError(companyId, expectedRows, deletedRows);
        }
        await transaction.query("COMMIT");
        return deletedRows;
      } catch (error) {
        if (!(error instanceof CompanyAnonymizedActivityRetentionMismatchError)) {
          try {
            await client?.query("ROLLBACK");
          } catch {
            // Preserve the original persistence failure.
          }
          throw mapPostgresError(error);
        }
        throw error;
      } finally {
        client?.release();
      }
    },
  };
}
