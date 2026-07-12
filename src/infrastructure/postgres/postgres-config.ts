export type PostgresConfig = {
  databaseUrl: string;
  ssl: false | { rejectUnauthorized: boolean };
  max: number;
  connectionTimeoutMillis: number;
  statementTimeoutMillis: number;
  inviteCodePepper: string;
  telegramIdentityPepper: string;
};

export function postgresConfigFromEnv(env: NodeJS.ProcessEnv): PostgresConfig {
  const databaseUrl = env.DATABASE_URL;
  const sslMode = env.DATABASE_SSL_MODE ?? "require";
  if (!databaseUrl) throw new Error("DATABASE_URL is required for postgres runtime");
  if (!env.INVITE_CODE_PEPPER) throw new Error("INVITE_CODE_PEPPER is required for postgres runtime");
  if (!env.TELEGRAM_IDENTITY_PEPPER) throw new Error("TELEGRAM_IDENTITY_PEPPER is required for postgres runtime");
  if (!["require", "prefer", "disable"].includes(sslMode)) throw new Error("DATABASE_SSL_MODE must be require, prefer, or disable");
  return {
    databaseUrl,
    ssl: sslMode === "disable" ? false : { rejectUnauthorized: sslMode === "require" },
    max: parsePositiveInt(env.DATABASE_POOL_MAX, 10),
    connectionTimeoutMillis: parsePositiveInt(env.DATABASE_CONNECT_TIMEOUT_MS, 5_000),
    statementTimeoutMillis: parsePositiveInt(env.DATABASE_STATEMENT_TIMEOUT_MS, 10_000),
    inviteCodePepper: env.INVITE_CODE_PEPPER,
    telegramIdentityPepper: env.TELEGRAM_IDENTITY_PEPPER,
  };
}
function parsePositiveInt(value: string | undefined, fallback: number) { const parsed = Number.parseInt(value ?? "", 10); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback; }
