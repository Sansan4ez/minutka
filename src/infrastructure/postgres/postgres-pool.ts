import { Pool, type PoolClient } from "pg";
import type { PostgresConfig } from "./postgres-config.js";

export type SqlExecutor = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export function createPostgresPool(config: PostgresConfig): Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    ssl: config.ssl,
    max: config.max,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    options: `-c statement_timeout=${config.statementTimeoutMillis}`,
  });
}

export async function withTransaction<T>(pool: Pool, callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const result = await callback(client); await client.query("COMMIT"); return result; }
  catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}
