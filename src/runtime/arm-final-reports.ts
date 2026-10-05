import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { FinalReportArmingService } from "../application/final-report-arming.js";
import { ScheduleManagementService } from "../application/schedule-management-service.js";
import { systemClock } from "../application/runtime-primitives.js";
import { loadDotEnv } from "../config/env.js";
import { migrationStatus } from "../infrastructure/postgres/postgres-migrator.js";
import { postgresConfigFromEnv } from "../infrastructure/postgres/postgres-config.js";
import { createPostgresPool } from "../infrastructure/postgres/postgres-pool.js";
import { createPostgresProfileStore } from "../infrastructure/postgres/postgres-profile-store.js";
import { createPostgresScheduleStore } from "../infrastructure/postgres/postgres-schedule-store.js";
import { runArmFinalReportsCommand } from "./arm-final-reports-command.js";

loadDotEnv();
const config = postgresConfigFromEnv(process.env);
const pool = createPostgresPool(config);
const terminal = createInterface({ input: stdin, output: stdout });
try {
  const status = await migrationStatus(pool);
  if (status.pending.length) {
    throw new Error(`database migrations are pending: ${status.pending.join(", ")}; run npm run db:migrate`);
  }
  const profileStore = createPostgresProfileStore(pool, config.inviteCodePepper);
  await runArmFinalReportsCommand(process.argv.slice(2), {
    service: new FinalReportArmingService(
      profileStore,
      new ScheduleManagementService(createPostgresScheduleStore(pool), profileStore, systemClock),
    ),
    readConfirmation: () => terminal.question(""),
    write: (text) => stdout.write(text),
  });
} finally {
  terminal.close();
  await pool.end();
}
