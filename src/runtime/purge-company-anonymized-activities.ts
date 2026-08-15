import { CompanyAnonymizedActivityRetentionService } from "../application/company-anonymized-activity-retention.js";
import { migrationStatus } from "../infrastructure/postgres/postgres-migrator.js";
import { postgresConfigFromEnv } from "../infrastructure/postgres/postgres-config.js";
import { createPostgresCompanyAnonymizedActivityRetentionStore } from "../infrastructure/postgres/postgres-company-anonymized-activity-retention-store.js";
import { createPostgresPool } from "../infrastructure/postgres/postgres-pool.js";

const companyId = process.argv[2]?.trim();
if (!companyId) throw new Error("company_id argument is required");

const pool = createPostgresPool(postgresConfigFromEnv(process.env));
try {
  const status = await migrationStatus(pool);
  if (status.pending.length) {
    throw new Error(`database migrations are pending: ${status.pending.join(", ")}; run npm run db:migrate`);
  }
  const retention = new CompanyAnonymizedActivityRetentionService(
    createPostgresCompanyAnonymizedActivityRetentionStore(pool),
  );
  console.log(JSON.stringify(await retention.purgeCompany({ companyId })));
} finally {
  await pool.end();
}
