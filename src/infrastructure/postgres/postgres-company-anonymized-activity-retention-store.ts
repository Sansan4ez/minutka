import type { Pool } from "pg";
import type { CompanyAnonymizedActivityRetentionStore } from "../../application/company-anonymized-activity-retention.js";
import { mapPostgresError } from "../../application/persistence-error.js";

export function createPostgresCompanyAnonymizedActivityRetentionStore(
  pool: Pool,
): CompanyAnonymizedActivityRetentionStore {
  return {
    async deleteByCompany(companyId) {
      try {
        const result = await pool.query(
          "DELETE FROM minutka_reporting.anonymized_activities WHERE company_id = $1",
          [companyId],
        );
        return result.rowCount ?? 0;
      } catch (error) {
        throw mapPostgresError(error);
      }
    },
  };
}
