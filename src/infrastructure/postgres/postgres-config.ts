import { integrationEncryptionKeyFromBase64 } from "./secret-box.js";

export type PostgresConnectionConfig = {
  databaseUrl: string;
  ssl: false | { rejectUnauthorized: boolean };
  max: number;
  connectionTimeoutMillis: number;
  statementTimeoutMillis: number;
};

export type PostgresConfig = PostgresConnectionConfig & {
  inviteCodePepper: string;
  telegramIdentityPepper: string;
  integrationEncryptionKey?: Buffer;
};

export function postgresConfigFromEnv(env: NodeJS.ProcessEnv): PostgresConfig {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for postgres runtime");
  if (!env.INVITE_CODE_PEPPER) throw new Error("INVITE_CODE_PEPPER is required for postgres runtime");
  if (!env.TELEGRAM_IDENTITY_PEPPER) throw new Error("TELEGRAM_IDENTITY_PEPPER is required for postgres runtime");
  const telegramMode = env.TELEGRAM_MODE ?? "disabled";
  if (telegramMode === "polling" && !env.INTEGRATION_ENC_KEY) {
    throw new Error("TELEGRAM_MODE=polling requires INTEGRATION_ENC_KEY");
  }
  const integrationEncryptionKey = env.INTEGRATION_ENC_KEY
    ? integrationEncryptionKeyFromBase64(env.INTEGRATION_ENC_KEY)
    : undefined;
  return {
    ...postgresConnectionConfigForDatabaseUrl(env, databaseUrl),
    inviteCodePepper: env.INVITE_CODE_PEPPER,
    telegramIdentityPepper: env.TELEGRAM_IDENTITY_PEPPER,
    integrationEncryptionKey,
  };
}

export function postgresMigrationConfigFromEnv(env: NodeJS.ProcessEnv): PostgresConnectionConfig {
  const databaseUrl = env.MIGRATION_DATABASE_URL;
  if (!databaseUrl) throw new Error("MIGRATION_DATABASE_URL is required for operator database access");
  return postgresConnectionConfigForDatabaseUrl(env, databaseUrl);
}

function postgresConnectionConfigForDatabaseUrl(
  env: NodeJS.ProcessEnv,
  databaseUrl: string,
): PostgresConnectionConfig {
  const sslMode = env.DATABASE_SSL_MODE ?? "require";
  if (!["require", "disable"].includes(sslMode)) {
    throw new Error("DATABASE_SSL_MODE must be require or disable");
  }
  return {
    databaseUrl,
    ssl: sslMode === "disable" ? false : { rejectUnauthorized: true },
    max: parsePositiveInt(env.DATABASE_POOL_MAX, 10),
    connectionTimeoutMillis: parsePositiveInt(env.DATABASE_CONNECT_TIMEOUT_MS, 5_000),
    statementTimeoutMillis: parsePositiveInt(env.DATABASE_STATEMENT_TIMEOUT_MS, 10_000),
  };
}
function parsePositiveInt(value: string | undefined, fallback: number) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`Expected a positive integer, received ${JSON.stringify(value)}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive integer, received ${JSON.stringify(value)}`);
  return parsed;
}
