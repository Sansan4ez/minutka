import type { Pool } from "pg";
import { loadMigrationFiles } from "./migration-files.js";
import { withTransaction } from "./postgres-pool.js";

export async function migratePostgres(pool: Pool): Promise<{ applied: string[]; pending: string[] }> {
  return withTransaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('minutka_schema_migrations'))");
    await client.query("CREATE SCHEMA IF NOT EXISTS minutka_meta");
    await client.query("CREATE TABLE IF NOT EXISTS minutka_meta.schema_migrations (version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
    const migrations = await loadMigrationFiles();
    const appliedRows = await client.query<{ version: string; checksum: string }>("SELECT version, checksum FROM minutka_meta.schema_migrations");
    const applied = new Map(appliedRows.rows.map((row) => [row.version, row.checksum]));
    const completed: string[] = [];
    const pending: string[] = [];
    for (const migration of migrations) {
      const existing = applied.get(migration.version);
      if (existing && existing !== migration.checksum) throw new Error(`migration checksum mismatch: ${migration.version}`);
      if (existing) continue;
      pending.push(migration.version);
      await client.query(migration.sql);
      await client.query("INSERT INTO minutka_meta.schema_migrations(version, name, checksum) VALUES ($1, $2, $3)", [migration.version, migration.name, migration.checksum]);
      completed.push(migration.version);
    }
    return { applied: completed, pending };
  });
}

export async function migrationStatus(pool: Pool): Promise<{ applied: string[]; pending: string[] }> {
  await pool.query("CREATE SCHEMA IF NOT EXISTS minutka_meta");
  await pool.query("CREATE TABLE IF NOT EXISTS minutka_meta.schema_migrations (version text PRIMARY KEY, name text NOT NULL, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())");
  const migrations = await loadMigrationFiles();
  const result = await pool.query<{ version: string; checksum: string }>("SELECT version, checksum FROM minutka_meta.schema_migrations");
  const stored = new Map(result.rows.map((row) => [row.version, row.checksum]));
  for (const migration of migrations) if (stored.has(migration.version) && stored.get(migration.version) !== migration.checksum) throw new Error(`migration checksum mismatch: ${migration.version}`);
  return { applied: migrations.filter((migration) => stored.has(migration.version)).map((migration) => migration.version), pending: migrations.filter((migration) => !stored.has(migration.version)).map((migration) => migration.version) };
}
