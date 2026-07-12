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
  if (!["require", "disable"].includes(sslMode)) {
    throw new Error("DATABASE_SSL_MODE must be require or disable");
  }
  return {
    databaseUrl,
    ssl: sslMode === "disable" ? false : { rejectUnauthorized: true },
    max: parsePositiveInt(env.DATABASE_POOL_MAX, 10),
    connectionTimeoutMillis: parsePositiveInt(env.DATABASE_CONNECT_TIMEOUT_MS, 5_000),
    statementTimeoutMillis: parsePositiveInt(env.DATABASE_STATEMENT_TIMEOUT_MS, 10_000),
    inviteCodePepper: env.INVITE_CODE_PEPPER,
    telegramIdentityPepper: env.TELEGRAM_IDENTITY_PEPPER,
  };
}
function parsePositiveInt(value: string | undefined, fallback: number) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new Error(`Expected a positive integer, received ${JSON.stringify(value)}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`Expected a positive integer, received ${JSON.stringify(value)}`);
  return parsed;
}
