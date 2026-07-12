import { createPostgresPool } from "./postgres-pool.js";
import { postgresConfigFromEnv } from "./postgres-config.js";
import { migratePostgres, migrationStatus } from "./postgres-migrator.js";

const pool = createPostgresPool(postgresConfigFromEnv(process.env));
try {
  const result = process.argv.includes("--status") ? await migrationStatus(pool) : await migratePostgres(pool);
  console.log(JSON.stringify(result));
} finally { await pool.end(); }
