import { createPostgresPool } from "./postgres-pool.js";
import { postgresConfigFromEnv } from "./postgres-config.js";
import { migratePostgres, migrationStatus } from "./postgres-migrator.js";

const migrationDatabaseUrl = process.env.MIGRATION_DATABASE_URL;
if (!migrationDatabaseUrl) throw new Error("MIGRATION_DATABASE_URL is required for db:migrate");
const pool = createPostgresPool(postgresConfigFromEnv({ ...process.env, DATABASE_URL: migrationDatabaseUrl }));
try {
  const result = process.argv.includes("--status") ? await migrationStatus(pool) : await migratePostgres(pool);
  console.log(JSON.stringify(result));
} finally { await pool.end(); }
