{ lib, pkgs, minutkaPackage, minutkaSecrets, ... }:

let
  postgres = pkgs.postgresql_16;
  secretPaths = minutkaSecrets.runtimeSecretPaths;

  databaseSetup = pkgs.writeShellApplication {
    name = "minutka-postgres-setup";
    runtimeInputs = [ postgres pkgs.coreutils ];
    text = ''
      set -euo pipefail

      psql -v ON_ERROR_STOP=1 --dbname postgres <<'SQL'
      \set runtime_password `cat "$MINUTKA_DB_PASSWORD_FILE"`
      \set migrator_password `cat "$MINUTKA_MIGRATOR_DB_PASSWORD_FILE"`

      SELECT format('CREATE ROLE minutka_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L', :'migrator_password')
      WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'minutka_migrator') \gexec
      SELECT format('ALTER ROLE minutka_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L', :'migrator_password') \gexec

      SELECT format('CREATE ROLE minutka_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L', :'runtime_password')
      WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'minutka_runtime') \gexec
      SELECT format('ALTER ROLE minutka_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD %L', :'runtime_password') \gexec
      SQL

      db_owner="$(psql -d postgres -tAc "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = 'minutka'")"
      if [ -z "$db_owner" ]; then
        createdb --owner=minutka_migrator --encoding=UTF8 --locale=C --template=template0 minutka
      elif [ "$db_owner" != "minutka_migrator" ]; then
        echo "minutka database must be owned by minutka_migrator, found $db_owner" >&2
        exit 1
      fi
    '';
  };

  databaseMigrate = pkgs.writeShellApplication {
    name = "minutka-postgres-migrate";
    runtimeInputs = [ pkgs.coreutils ];
    text = ''
      set -euo pipefail
      exec ${minutkaPackage}/bin/minutka-db-migrate
    '';
  };
in
{
  assertions = [
    {
      assertion = minutkaSecrets ? runtimeSecretPaths;
      message = "minutka-secrets.nix must provide PostgreSQL bootstrap secret paths.";
    }
    {
      assertion = secretPaths ? minutka_db_password && secretPaths ? minutka_migrator_db_password;
      message = "PostgreSQL bootstrap requires the runtime and migrator password secret paths.";
    }
  ];

  services.postgresql = {
    enable = true;
    package = postgres;
    enableTCPIP = false;
    dataDir = "/var/lib/minutka/postgresql/16";
    initdbArgs = [ "--data-checksums" "--encoding=UTF8" "--locale=C" ];
    authentication = lib.mkForce ''
      local all postgres          peer map=postgres
      local minutka minutka_runtime  scram-sha-256
      local minutka minutka_migrator scram-sha-256
      local all all               reject
    '';
    identMap = lib.mkAfter "postgres root postgres";
    settings = {
      listen_addresses = lib.mkForce "";
      password_encryption = "scram-sha-256";
      unix_socket_directories = "/run/postgresql";
    };
  };

  systemd.tmpfiles.rules = [
    "d /var/lib/minutka 0750 root postgres -"
    "d /var/lib/minutka/postgresql 0750 postgres postgres -"
    "d /var/lib/minutka/postgresql/16 0700 postgres postgres -"
  ];

  systemd.services.postgresql.unitConfig.RequiresMountsFor = "/var/lib/minutka/postgresql/16";

  systemd.services.minutka-postgres-setup = {
    description = "Provision minutka PostgreSQL roles and database";
    after = [ "postgresql.target" ];
    requires = [ "postgresql.target" ];
    before = [ "minutka-postgres-migrate.service" ];
    wantedBy = [ "minutka-postgres-migrate.service" ];

    environment = {
      PGHOST = "/run/postgresql";
      PGUSER = "postgres";
      PGAPPNAME = "minutka-postgres-setup";
      MINUTKA_DB_PASSWORD_FILE = secretPaths.minutka_db_password;
      MINUTKA_MIGRATOR_DB_PASSWORD_FILE = secretPaths.minutka_migrator_db_password;
    };

    serviceConfig = {
      Type = "oneshot";
      User = "postgres";
      Group = "postgres";
      ExecStart = lib.getExe databaseSetup;
    };
  };

  systemd.services.minutka-postgres-migrate = {
    description = "Apply minutka PostgreSQL migrations";
    after = [ "minutka-postgres-setup.service" ];
    requires = [ "minutka-postgres-setup.service" ];
    before = [ "minutka.service" ];
    wantedBy = [ "minutka.service" ];

    environment = {
      DATABASE_SSL_MODE = "disable";
      PGAPPNAME = "minutka-postgres-migrate";
      INVITE_CODE_PEPPER = "migration-configuration-only";
      TELEGRAM_IDENTITY_PEPPER = "migration-configuration-only";
    };

    serviceConfig = {
      Type = "oneshot";
      User = "minutka";
      Group = "minutka";
      WorkingDirectory = "${minutkaPackage}/lib/minutka";
      EnvironmentFile = minutkaSecrets.environmentFile;
      ExecStart = lib.getExe databaseMigrate;
      NoNewPrivileges = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      PrivateTmp = true;
      PrivateDevices = true;
      RestrictAddressFamilies = [ "AF_UNIX" ];
    };
  };
}
