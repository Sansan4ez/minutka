import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { WorkRetrospectivePolicyManagement } from "../application/work-retrospective-policy-management.js";
import { systemClock } from "../application/runtime-primitives.js";
import { loadDotEnv } from "../config/env.js";
import { migrationStatus } from "../infrastructure/postgres/postgres-migrator.js";
import { postgresConfigFromEnv } from "../infrastructure/postgres/postgres-config.js";
import { createPostgresPool } from "../infrastructure/postgres/postgres-pool.js";
import { createPostgresTenantDirectoryStore } from "../infrastructure/postgres/postgres-tenant-directory-store.js";
import { createPostgresWorkRetrospectivePolicyStore } from "../infrastructure/postgres/postgres-work-retrospective-policy-store.js";
import { runWorkRetrospectivePolicyCommand } from "./work-retrospective-policy-command.js";

process.exitCode = await runWorkRetrospectivePolicyCommand(process.argv.slice(2), async () => {
  loadDotEnv();
  const pool = createPostgresPool(postgresConfigFromEnv(process.env));
  try {
    const status = await migrationStatus(pool);
    if (status.pending.length) throw new Error("database migrations are pending; run npm run db:migrate on deployment");
    const terminal = createInterface({ input: stdin, output: stdout });
    return {
      service: new WorkRetrospectivePolicyManagement(createPostgresWorkRetrospectivePolicyStore(pool), createPostgresTenantDirectoryStore(pool), systemClock,
        async event => { stdout.write(JSON.stringify({ event: "retrospective_policy_changed", ...event }) + "\n"); }),
      write: (text: string) => { stdout.write(text); }, readConfirmation: () => terminal.question(""),
      close: async () => { terminal.close(); await pool.end(); },
    };
  } catch (error) { await pool.end(); throw error; }
}, text => { stdout.write(text); });
