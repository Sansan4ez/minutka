{ lib, pkgs, personalAssistantSecrets, ... }:

let
  backupRoot = "/var/backups/personal-assistant";
  stateDir = "/var/lib/personal-assistant-observability";
  restoreSmokeStateDir = "/var/lib/personal-assistant-restore-smoke";
  restoreSmokeBackupDir = "${restoreSmokeStateDir}/backup";
  database = "minutka";
  bucket = "personal-assistant";
  endpoint = "http://127.0.0.1:9000";
  secretPaths = personalAssistantSecrets.runtimeSecretPaths;

  backupScript = pkgs.writeShellApplication {
    name = "personal-assistant-backup";
    runtimeInputs = with pkgs; [
      coreutils
      findutils
      minio-client
      postgresql_16
    ];
    text = ''
      set -euo pipefail

      timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
      target_dir="${backupRoot}/$timestamp"
      incomplete_dir="$target_dir.incomplete"
      minio_config_dir="$(mktemp -d)"

      cleanup() {
        rm -rf "$minio_config_dir"
        rm -rf "$incomplete_dir"
      }
      trap cleanup EXIT

      mkdir -p "$incomplete_dir/minio/$MINIO_BUCKET"
      mkdir -p "${stateDir}"

      pg_dump \
        -h /run/postgresql \
        -U ${database}_migrator \
        -d ${database} \
        -Fc \
        -f "$incomplete_dir/${database}.dump"

      minio_access_key="$(< "$MINIO_ACCESS_KEY_FILE")"
      minio_secret_key="$(< "$MINIO_SECRET_KEY_FILE")"
      export MC_CONFIG_DIR="$minio_config_dir"
      mc alias set backup "$MINIO_ENDPOINT" "$minio_access_key" "$minio_secret_key" >/dev/null
      mc mirror --preserve "backup/$MINIO_BUCKET" "$incomplete_dir/minio/$MINIO_BUCKET"
      minio_access_key=
      minio_secret_key=

      mv "$incomplete_dir" "$target_dir"
      find "${backupRoot}" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
      date -u +%s > "${stateDir}/backup.last_success"

      echo "Backup completed: $target_dir"
    '';
  };

  restoreSmokeScript = pkgs.writeShellApplication {
    name = "personal-assistant-restore-smoke";
    runtimeInputs = with pkgs; [
      coreutils
      findutils
      minio-client
      postgresql_16
    ];
    text = ''
      set -euo pipefail

      backup_dir="''${1:-}"
      if [ -z "$backup_dir" ]; then
        if [ -d ${restoreSmokeBackupDir} ]; then
          backup_dir=${restoreSmokeBackupDir}
        else
          backup_dir="$(find ${backupRoot} -mindepth 1 -maxdepth 1 -type d -not -name '*.incomplete' -printf '%f\n' | sort | tail -n 1)"
          if [ -n "$backup_dir" ]; then
            backup_dir="${backupRoot}/$backup_dir"
          fi
        fi
      fi
      if [ -z "$backup_dir" ] || [ ! -d "$backup_dir" ]; then
        echo "No staged or completed backup found." >&2
        exit 1
      fi

      if [ ! -s "$backup_dir/${database}.dump" ]; then
        echo "Backup dump is missing or empty: $backup_dir/${database}.dump" >&2
        exit 1
      fi
      if [ ! -d "$backup_dir/minio/$MINIO_BUCKET" ]; then
        echo "Backup MinIO mirror is missing: $backup_dir/minio/$MINIO_BUCKET" >&2
        exit 1
      fi

      temp_database="personal_assistant_restore_smoke_$(date -u +%s)_$$"
      minio_config_dir="$(mktemp -d -p ${restoreSmokeStateDir} minio-config.XXXXXX)"
      minio_restore_dir="$(mktemp -d -p ${restoreSmokeStateDir} minio-restore.XXXXXX)"

      cleanup() {
        dropdb -h /run/postgresql -U postgres --if-exists "$temp_database" >/dev/null 2>&1 || true
        rm -rf "$minio_config_dir" "$minio_restore_dir"
      }
      trap cleanup EXIT

      createdb -h /run/postgresql -U postgres \
        --owner=${database}_migrator \
        --encoding=UTF8 \
        --locale=C \
        --template=template0 \
        "$temp_database"
      pg_restore -h /run/postgresql -U postgres \
        --no-owner \
        --role=${database}_migrator \
        --dbname="$temp_database" \
        "$backup_dir/${database}.dump"

      report_count() {
        local label="$1"
        local restored_count="$2"
        local live_count="$3"

        if [ "$restored_count" -eq 0 ] && [ "$live_count" -gt 0 ]; then
          echo "Backup content loss for $label: restored=$restored_count live=$live_count" >&2
          exit 1
        fi
        if [ "$restored_count" -ne "$live_count" ]; then
          echo "Count drift for $label: restored=$restored_count live=$live_count"
        fi
      }

      tables=(participants consents process_schedules ideas tasks messages)
      for table in "''${tables[@]}"; do
        restored_table="$(psql -h /run/postgresql -U postgres -d "$temp_database" -Atc "SELECT to_regclass('minutka_private.$table')")"
        if [ -z "$restored_table" ]; then
          echo "Restored backup is missing table minutka_private.$table" >&2
          exit 1
        fi

        live_count="$(psql -h /run/postgresql -U postgres -d ${database} -Atc "SELECT count(*) FROM minutka_private.$table")"
        restored_count="$(psql -h /run/postgresql -U postgres -d "$temp_database" -Atc "SELECT count(*) FROM minutka_private.$table")"
        report_count "table minutka_private.$table" "$restored_count" "$live_count"
      done

      minio_access_key="$(< "$MINIO_ACCESS_KEY_FILE")"
      minio_secret_key="$(< "$MINIO_SECRET_KEY_FILE")"
      export MC_CONFIG_DIR="$minio_config_dir"
      mc alias set production "$MINIO_ENDPOINT" "$minio_access_key" "$minio_secret_key" >/dev/null
      mkdir -p "$minio_restore_dir/live"
      mc mirror "production/$MINIO_BUCKET" "$minio_restore_dir/live"
      minio_access_key=
      minio_secret_key=

      backup_document_count="$(find "$backup_dir/minio/$MINIO_BUCKET" -type f -path '*/context/*.md' -printf x | wc -c)"
      live_document_count="$(find "$minio_restore_dir/live" -type f -path '*/context/*.md' -printf x | wc -c)"
      report_count "context documents" "$backup_document_count" "$live_document_count"

      while IFS= read -r -d $'\0' document; do
        if [ ! -r "$document" ] || ! head -c 1 "$document" >/dev/null; then
          echo "Backup context document is unreadable: $document" >&2
          exit 1
        fi
      done < <(find "$backup_dir/minio/$MINIO_BUCKET" -type f -path '*/context/*.md' -print0)

      echo "Restore smoke passed: $backup_dir"
      echo "PostgreSQL tables restored and checked: ''${tables[*]}"
      echo "Readable restored context documents: $backup_document_count"
    '';
  };
in
{
  assertions = [
    {
      assertion = personalAssistantSecrets ? runtimeSecretPaths;
      message = "assistant-secrets.nix must provide backup credential paths.";
    }
    {
      assertion = secretPaths ? minio_access_key && secretPaths ? minio_secret_key
        && secretPaths ? minutka_migrator_db_password;
      message = "Backup requires MinIO application credentials and the PostgreSQL migrator password.";
    }
  ];

  environment.systemPackages = [ backupScript restoreSmokeScript ];

  systemd.tmpfiles.rules = [
    "d ${backupRoot} 0750 personal-assistant personal-assistant -"
    "d ${stateDir} 0750 personal-assistant personal-assistant -"
    "d ${restoreSmokeStateDir} 0700 postgres postgres -"
    "d ${restoreSmokeBackupDir} 0700 postgres postgres -"
  ];

  systemd.services.personal-assistant-backup = {
    description = "Back up personal-assistant PostgreSQL and the complete MinIO bucket";
    after = [ "postgresql.service" "minio.service" "personal-assistant-minio-provision.service" ];
    requires = [ "postgresql.service" "minio.service" "personal-assistant-minio-provision.service" ];

    environment = {
      PGHOST = "/run/postgresql";
      PGPASSFILE = personalAssistantSecrets.backupPgpassFile;
      MINIO_ENDPOINT = endpoint;
      MINIO_BUCKET = bucket;
      MINIO_ACCESS_KEY_FILE = secretPaths.minio_access_key;
      MINIO_SECRET_KEY_FILE = secretPaths.minio_secret_key;
    };

    serviceConfig = {
      Type = "oneshot";
      User = "personal-assistant";
      Group = "personal-assistant";
      UMask = "0027";
      ExecStart = lib.getExe backupScript;
      ReadWritePaths = [ backupRoot stateDir ];
      NoNewPrivileges = true;
      ProtectSystem = "strict";
      ProtectHome = "read-only";
      PrivateTmp = true;
      PrivateDevices = true;
      RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" ];
    };
  };

  systemd.timers.personal-assistant-backup = {
    description = "Run personal-assistant backups daily";
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnCalendar = "daily";
      Persistent = true;
      RandomizedDelaySec = "15m";
      Unit = "personal-assistant-backup.service";
    };
  };

  systemd.services.personal-assistant-restore-smoke = {
    description = "Restore and verify a completed personal-assistant backup";
    after = [ "postgresql.service" "minio.service" "personal-assistant-minio-provision.service" ];
    requires = [ "postgresql.service" "minio.service" "personal-assistant-minio-provision.service" ];

    environment = {
      MINIO_ENDPOINT = endpoint;
      MINIO_BUCKET = bucket;
      MINIO_ACCESS_KEY_FILE = secretPaths.minio_access_key;
      MINIO_SECRET_KEY_FILE = secretPaths.minio_secret_key;
    };

    serviceConfig = {
      Type = "oneshot";
      User = "postgres";
      Group = "postgres";
      ExecStart = lib.getExe restoreSmokeScript;
      SupplementaryGroups = [ "personal-assistant" ];
      ReadWritePaths = [ restoreSmokeStateDir ];
      NoNewPrivileges = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      PrivateTmp = true;
      PrivateDevices = true;
      RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" ];
    };
  };
}
