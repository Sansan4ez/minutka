import { Pool, type PoolClient } from "pg";
import type { PostgresConfig } from "./postgres-config.js";

export type SqlExecutor = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export function createPostgresPool(config: PostgresConfig): Pool {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: config.ssl,
    max: config.max,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    options: `-c statement_timeout=${config.statementTimeoutMillis}`,
  });
  // node-postgres emits this for a dropped idle client. An EventEmitter error
  // without a listener terminates Node, so retain only a safe operational hint.
  pool.on("error", (error) => {
    console.error(`PostgreSQL idle client error (${error instanceof Error ? error.name : "UnknownError"}).`);
  });
  return pool;
}

export async function withTransaction<T>(pool: Pool, callback: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let releaseError: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // A client that cannot roll back may be protocol-corrupted; evict it.
      releaseError = error instanceof Error ? error : new Error("transaction rollback failed");
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}
