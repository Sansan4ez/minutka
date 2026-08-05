{ lib, pkgs, site, personalAssistantSecrets, ... }:

let
  backupRoot = "/var/backups/personal-assistant";
  stateDir = "/var/lib/personal-assistant-observability";
  restoreSmokeStateDir = "/var/lib/personal-assistant-restore-smoke";
  restoreSmokeBackupDir = "${restoreSmokeStateDir}/backup";
  database = "minutka";
  bucket = "personal-assistant";
  endpoint = "http://127.0.0.1:9000";
  knowledgeBasePath = site.backup.knowledgeBasePath;
  knowledgeBaseGroup = site.backup.knowledgeBaseGroup;
  secretPaths = personalAssistantSecrets.runtimeSecretPaths;

  backupScript = pkgs.writeShellApplication {
    name = "personal-assistant-backup";
    runtimeInputs = with pkgs; [
      coreutils
      findutils
      git
      minio-client
      postgresql_16
      rsync
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

      mkdir -p "$incomplete_dir/minio"
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

      git_cmd=(git -c safe.directory="$KNOWLEDGE_BASE_PATH" -C "$KNOWLEDGE_BASE_PATH")
      "''${git_cmd[@]}" diff --quiet
      "''${git_cmd[@]}" diff --cached --quiet
      "''${git_cmd[@]}" bundle create \
        "$incomplete_dir/user-knowledge-base.bundle" --all
      "''${git_cmd[@]}" bundle verify "$incomplete_dir/user-knowledge-base.bundle"
      "''${git_cmd[@]}" rev-parse HEAD \
        > "$incomplete_dir/user-knowledge-base.head"
      mkdir -p "$incomplete_dir/user-knowledge-base-worktree"
      rsync -a --delete --exclude=.git/ \
        "$KNOWLEDGE_BASE_PATH/" \
        "$incomplete_dir/user-knowledge-base-worktree/"

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
      git
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
          backup_dir="$(find ${backupRoot} -mindepth 1 -maxdepth 1 -type d -mmin +1380 -printf '%f\n' | sort | tail -n 1)"
          if [ -n "$backup_dir" ]; then
            backup_dir="${backupRoot}/$backup_dir"
          fi
        fi
      fi
      if [ -z "$backup_dir" ] || [ ! -d "$backup_dir" ]; then
        echo "No staged backup or completed backup at least 23 hours old found." >&2
        exit 1
      fi

      test -s "$backup_dir/${database}.dump"
      test -s "$backup_dir/user-knowledge-base.bundle"
      test -s "$backup_dir/user-knowledge-base.head"
      test -d "$backup_dir/minio"

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

      tables=(participants consents process_schedules ideas tasks messages)
      for table in "''${tables[@]}"; do
        production_count="$(psql -h /run/postgresql -U postgres -d ${database} -Atc "SELECT count(*) FROM minutka_private.$table")"
        restored_count="$(psql -h /run/postgresql -U postgres -d "$temp_database" -Atc "SELECT count(*) FROM minutka_private.$table")"
        if [ "$production_count" != "$restored_count" ]; then
          echo "Row count mismatch for $table: production=$production_count restored=$restored_count" >&2
          exit 1
        fi
      done

      minio_access_key="$(< "$MINIO_ACCESS_KEY_FILE")"
      minio_secret_key="$(< "$MINIO_SECRET_KEY_FILE")"
      export MC_CONFIG_DIR="$minio_config_dir"
      mc alias set production "$MINIO_ENDPOINT" "$minio_access_key" "$minio_secret_key" >/dev/null
      mkdir -p "$minio_restore_dir/live"
      mc mirror "production/$MINIO_BUCKET" "$minio_restore_dir/live"
      minio_access_key=
      minio_secret_key=

      backup_document_count="$(find "$backup_dir/minio" -type f -path '*/context/*.md' -printf x | wc -c)"
      live_document_count="$(find "$minio_restore_dir/live" -type f -path '*/context/*.md' -printf x | wc -c)"
      if [ "$backup_document_count" != "$live_document_count" ]; then
        echo "Context document count mismatch: backup=$backup_document_count /proc/context=$live_document_count" >&2
        exit 1
      fi

      while IFS= read -r document; do
        test -r "$document"
        head -c 1 "$document" >/dev/null
      done < <(find "$backup_dir/minio" -type f -path '*/context/*.md' -print)

      git -C "$minio_restore_dir" init --quiet
      git -C "$minio_restore_dir" bundle verify "$backup_dir/user-knowledge-base.bundle" >/dev/null

      echo "Restore smoke passed: $backup_dir"
      echo "PostgreSQL row counts match for: ''${tables[*]}"
      echo "Readable /proc/context documents: $backup_document_count"
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
    {
      assertion = lib.hasPrefix "/" knowledgeBasePath;
      message = "site.backup.knowledgeBasePath must be an absolute path.";
    }
    {
      assertion = knowledgeBaseGroup == "personal-assistant";
      message = "site.backup.knowledgeBaseGroup must grant only the personal-assistant service group read access.";
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
    description = "Back up personal-assistant PostgreSQL, MinIO, and knowledge-base Git repository";
    after = [ "postgresql.service" "minio.service" "personal-assistant-minio-provision.service" ];
    requires = [ "postgresql.service" "minio.service" "personal-assistant-minio-provision.service" ];

    environment = {
      PGHOST = "/run/postgresql";
      PGPASSFILE = personalAssistantSecrets.backupPgpassFile;
      MINIO_ENDPOINT = endpoint;
      MINIO_BUCKET = bucket;
      MINIO_ACCESS_KEY_FILE = secretPaths.minio_access_key;
      MINIO_SECRET_KEY_FILE = secretPaths.minio_secret_key;
      KNOWLEDGE_BASE_PATH = knowledgeBasePath;
    };

    unitConfig.RequiresMountsFor = [ knowledgeBasePath site.storage.minio.dataDir ];

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
    after = [ "postgresql.service" "minio.service" ];
    requires = [ "postgresql.service" "minio.service" ];

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
