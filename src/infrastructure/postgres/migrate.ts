import { createPostgresPool } from "./postgres-pool.js";
import { postgresMigrationConfigFromEnv } from "./postgres-config.js";
import { migratePostgres, migrationStatus } from "./postgres-migrator.js";

// Migrations may legitimately outlast the runtime query budget; retain all
// other connection settings while disabling only statement_timeout here.
const pool = createPostgresPool({
  ...postgresMigrationConfigFromEnv(process.env),
  statementTimeoutMillis: 0,
});
try {
  const result = process.argv.includes("--status") ? await migrationStatus(pool) : await migratePostgres(pool);
  console.log(JSON.stringify(result));
} finally { await pool.end(); }
