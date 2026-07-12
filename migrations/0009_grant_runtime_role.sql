GRANT USAGE ON SCHEMA minutka_private, minutka_audit, minutka_meta TO minutka_runtime;
GRANT USAGE ON SCHEMA minutka_private, minutka_audit, minutka_meta TO minutka_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA minutka_private, minutka_audit TO minutka_runtime;
GRANT SELECT ON minutka_meta.schema_migrations TO minutka_runtime;

ALTER DEFAULT PRIVILEGES FOR ROLE minutka_migrator IN SCHEMA minutka_private
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO minutka_runtime;
ALTER DEFAULT PRIVILEGES FOR ROLE minutka_migrator IN SCHEMA minutka_audit
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO minutka_runtime;
