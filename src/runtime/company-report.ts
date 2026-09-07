import { stdout } from "node:process";
import { loadDotEnv } from "../config/env.js";
import { CompanyReportingService } from "../application/company-reporting.js";
import { createPostgresCompanyReportStore } from "../infrastructure/postgres/postgres-company-report-store.js";
import { postgresConfigFromEnv } from "../infrastructure/postgres/postgres-config.js";
import { migrationStatus } from "../infrastructure/postgres/postgres-migrator.js";
import { createPostgresPool } from "../infrastructure/postgres/postgres-pool.js";
import { checkReportPreflightWithAgent } from "../mastra/report-preflight-checker.js";
import { runCompanyReportCommand } from "./company-report-command.js";

loadDotEnv();
const pool = createPostgresPool(postgresConfigFromEnv(process.env));
try {
  const status = await migrationStatus(pool);
  if (status.pending.length) throw new Error(`database migrations are pending: ${status.pending.join(", ")}; run npm run db:migrate`);
  await runCompanyReportCommand(process.argv.slice(2), {
    reporting: new CompanyReportingService(createPostgresCompanyReportStore(pool)),
    checkLlm: checkReportPreflightWithAgent,
  }, (text) => stdout.write(text));
} finally {
  await pool.end();
}
