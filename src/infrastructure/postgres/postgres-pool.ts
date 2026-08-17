import { Pool, type PoolClient } from "pg";
import { PersistenceOutcomeUnknownError } from "../../application/persistence-error.js";
import type { PostgresConnectionConfig } from "./postgres-config.js";

export type SqlExecutor = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export function createPostgresPool(config: PostgresConnectionConfig): Pool {
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
    let result: T;
    try {
      result = await callback(client);
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // No COMMIT was sent, so the write is known not to have committed even
        // when the broken client must be evicted instead of reused.
        releaseError = error instanceof Error ? error : new Error("transaction rollback failed");
      }
      throw error;
    }
    try {
      await client.query("COMMIT");
    } catch (error) {
      if (hasPostgresSqlState(error)) {
        // The server observed and rejected COMMIT (for example, a deferred
        // constraint), so the transaction did not commit.
        throw error;
      }
      releaseError = error instanceof Error ? error : new Error("transaction commit outcome is unknown");
      throw new PersistenceOutcomeUnknownError({ cause: error });
    }
    return result;
  } finally {
    client.release(releaseError);
  }
}

function hasPostgresSqlState(error: unknown): boolean {
  return typeof (error as { code?: unknown } | undefined)?.code === "string"
    && /^[0-9A-Z]{5}$/u.test((error as { code: string }).code);
}
