CREATE SCHEMA IF NOT EXISTS minutka_private;
CREATE SCHEMA IF NOT EXISTS minutka_audit;
CREATE SCHEMA IF NOT EXISTS minutka_meta;

CREATE TABLE IF NOT EXISTS minutka_meta.schema_migrations (
  version text PRIMARY KEY,
  name text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
