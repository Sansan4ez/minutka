{ lib, pkgs, site, minutkaSecrets, ... }:

let
  textfileDir = "/var/lib/node-exporter-textfile";
  stateDir = "/var/lib/minutka-observability";
  database = "minutka";
  minioDataDir = site.storage.minio.dataDir;
  minioCapacityBytes = site.storage.minio.capacityBytes;
  minioFilesystemReserveBytes = site.storage.minio.filesystemReserveBytes;
  artifactOwnerSoftQuotaBytes = 2147483648;
  artifactOwnerHardQuotaBytes = 3221225472;
  artifactGlobalHardQuotaBytes = 48318382080;

  collectorScript = pkgs.writeShellApplication {
    name = "minutka-observability-collector";
    runtimeInputs = with pkgs; [ coreutils gnugrep gawk postgresql_16 systemd ];
    text = ''
      set -euo pipefail

      tmp_file="${textfileDir}/minutka.prom.tmp"
      out_file="${textfileDir}/minutka.prom"

      unit_active() {
        local unit="$1"
        if systemctl is-active --quiet "$unit"; then
          echo 1
        else
          echo 0
        fi
      }

      file_value_or_zero() {
        local path="$1"
        local value=0
        if [ -f "$path" ]; then
          value="$(tr -d '[:space:]' < "$path")"
          if ! [[ "$value" =~ ^[0-9]+$ ]]; then
            value=0
          fi
        fi
        echo "$value"
      }

      scalar_or_zero() {
        local value="$1"
        if [[ "$value" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
          echo "$value"
        else
          echo 0
        fi
      }

      filesystem_values="$(stat -f -c '%a %b %S' ${lib.escapeShellArg minioDataDir})"
      read -r filesystem_available_blocks filesystem_total_blocks filesystem_block_size <<< "$filesystem_values"
      minio_filesystem_free_bytes=$((filesystem_available_blocks * filesystem_block_size))
      minio_filesystem_total_bytes=$((filesystem_total_blocks * filesystem_block_size))
      minio_filesystem_used_bytes=$((minio_filesystem_total_bytes - minio_filesystem_free_bytes))
      minio_filesystem_use_percent="$(awk -v used="$minio_filesystem_used_bytes" -v total="$minio_filesystem_total_bytes" 'BEGIN { if (total > 0) printf "%.6f", (100 * used / total); else print 0 }')"
      minio_capacity_soft_threshold_bytes=$((${toString minioCapacityBytes} - ${toString minioFilesystemReserveBytes}))
      if [ "$minio_filesystem_used_bytes" -ge "$minio_capacity_soft_threshold_bytes" ]; then
        minio_capacity_soft_threshold_exceeded=1
      else
        minio_capacity_soft_threshold_exceeded=0
      fi

      metrics_row="$(psql -h /run/postgresql -U postgres -d ${database} -At -F ' ' -v ON_ERROR_STOP=1 <<'SQL'
      SELECT
        COALESCE(extract(epoch FROM max(completed_at))::bigint, 0),
        COALESCE((SELECT sum(estimated_cost_usd_micros)::numeric / 1000000 FROM minutka_private.usage WHERE usage_month = date_trunc('month', CURRENT_DATE)::date), 0),
        COALESCE((SELECT sum(size_bytes) FROM minutka_private.artifact_contents), 0),
        COALESCE((SELECT max(owner_bytes) FROM (SELECT sum(size_bytes) AS owner_bytes FROM minutka_private.artifact_contents GROUP BY user_id) owners), 0),
        COALESCE((SELECT count(*) FROM (SELECT user_id FROM minutka_private.artifact_contents GROUP BY user_id HAVING sum(size_bytes) >= ${toString artifactOwnerSoftQuotaBytes}) owners), 0)
      FROM minutka_private.schedule_fires
      WHERE status = 'succeeded';
SQL
      )"
      [ -n "$metrics_row" ]
      read -r schedule_last_success usage_monthly_cost artifact_unique_bytes artifact_owner_max_bytes artifact_owner_soft_exceeded <<< "$metrics_row"
      schedule_last_success="$(scalar_or_zero "$schedule_last_success")"
      usage_monthly_cost="$(scalar_or_zero "$usage_monthly_cost")"
      artifact_unique_bytes="$(scalar_or_zero "$artifact_unique_bytes")"
      artifact_owner_max_bytes="$(scalar_or_zero "$artifact_owner_max_bytes")"
      artifact_owner_soft_exceeded="$(scalar_or_zero "$artifact_owner_soft_exceeded")"

      application_journal="$(journalctl -u minutka.service --since '30 days ago' -o cat --no-pager || true)"
      artifact_object_limit_rejections="$(grep -F -c 'Artifact save rejected (object_limit).' <<< "$application_journal" || true)"
      artifact_owner_quota_rejections="$(grep -F -c 'Artifact save rejected (owner_quota).' <<< "$application_journal" || true)"
      artifact_global_capacity_rejections="$(grep -F -c 'Artifact save rejected (global_capacity).' <<< "$application_journal" || true)"

      cat > "$tmp_file" <<EOF
# HELP minutka_systemd_unit_active Whether the required systemd unit is active.
# TYPE minutka_systemd_unit_active gauge
minutka_systemd_unit_active{unit="postgresql.service"} $(unit_active postgresql.service)
minutka_systemd_unit_active{unit="minio.service"} $(unit_active minio.service)
minutka_systemd_unit_active{unit="minutka.service"} $(unit_active minutka.service)

# HELP minutka_backup_last_success_timestamp_seconds Unix timestamp of the last successful backup.
# TYPE minutka_backup_last_success_timestamp_seconds gauge
minutka_backup_last_success_timestamp_seconds $(file_value_or_zero "${stateDir}/backup.last_success")

# HELP minutka_smoke_last_success_timestamp_seconds Unix timestamp of the last successful smoke check.
# TYPE minutka_smoke_last_success_timestamp_seconds gauge
minutka_smoke_last_success_timestamp_seconds $(file_value_or_zero "${stateDir}/smoke.last_success")

# HELP minutka_schedule_fire_last_success_timestamp_seconds Unix timestamp of the last successful scheduled process fire.
# TYPE minutka_schedule_fire_last_success_timestamp_seconds gauge
minutka_schedule_fire_last_success_timestamp_seconds $schedule_last_success

# HELP minutka_usage_monthly_estimated_cost_usd Estimated model cost for all owners in the current UTC month.
# TYPE minutka_usage_monthly_estimated_cost_usd gauge
minutka_usage_monthly_estimated_cost_usd $usage_monthly_cost

# HELP minutka_minio_filesystem_free_bytes Bytes available on the filesystem containing MinIO data.
# TYPE minutka_minio_filesystem_free_bytes gauge
minutka_minio_filesystem_free_bytes $minio_filesystem_free_bytes
# HELP minutka_minio_filesystem_use_percent Used percentage of the filesystem containing MinIO data.
# TYPE minutka_minio_filesystem_use_percent gauge
minutka_minio_filesystem_use_percent $minio_filesystem_use_percent
# HELP minutka_minio_capacity_soft_threshold_exceeded Whether used bytes reached the configured capacity minus the hard filesystem reserve.
# TYPE minutka_minio_capacity_soft_threshold_exceeded gauge
minutka_minio_capacity_soft_threshold_exceeded $minio_capacity_soft_threshold_exceeded
# HELP minutka_minio_capacity_soft_threshold_bytes Used-byte threshold that preserves the filesystem reserve.
# TYPE minutka_minio_capacity_soft_threshold_bytes gauge
minutka_minio_capacity_soft_threshold_bytes $minio_capacity_soft_threshold_bytes

# HELP minutka_artifact_unique_cas_bytes Unique owner-scoped artifact CAS bytes across the pilot.
# TYPE minutka_artifact_unique_cas_bytes gauge
minutka_artifact_unique_cas_bytes $artifact_unique_bytes
# HELP minutka_artifact_owner_max_unique_cas_bytes Largest owner-scoped unique CAS usage without exposing owner identifiers.
# TYPE minutka_artifact_owner_max_unique_cas_bytes gauge
minutka_artifact_owner_max_unique_cas_bytes $artifact_owner_max_bytes
# HELP minutka_artifact_owner_soft_quota_exceeded_count Number of owners at or above the soft artifact quota, without owner labels.
# TYPE minutka_artifact_owner_soft_quota_exceeded_count gauge
minutka_artifact_owner_soft_quota_exceeded_count $artifact_owner_soft_exceeded
# HELP minutka_artifact_owner_soft_quota_bytes Configured per-owner soft artifact quota.
# TYPE minutka_artifact_owner_soft_quota_bytes gauge
minutka_artifact_owner_soft_quota_bytes ${toString artifactOwnerSoftQuotaBytes}
# HELP minutka_artifact_owner_hard_quota_bytes Configured per-owner hard artifact quota.
# TYPE minutka_artifact_owner_hard_quota_bytes gauge
minutka_artifact_owner_hard_quota_bytes ${toString artifactOwnerHardQuotaBytes}
# HELP minutka_artifact_global_hard_quota_bytes Configured global artifact hard quota.
# TYPE minutka_artifact_global_hard_quota_bytes gauge
minutka_artifact_global_hard_quota_bytes ${toString artifactGlobalHardQuotaBytes}
# HELP minutka_artifact_save_rejections_total Artifact save rejections seen in the retained application journal.
# TYPE minutka_artifact_save_rejections_total gauge
minutka_artifact_save_rejections_total{reason="object_limit"} $artifact_object_limit_rejections
minutka_artifact_save_rejections_total{reason="owner_quota"} $artifact_owner_quota_rejections
minutka_artifact_save_rejections_total{reason="global_capacity"} $artifact_global_capacity_rejections
EOF

      mv "$tmp_file" "$out_file"
    '';
  };
in
{
  assertions = [
    {
      assertion = minutkaSecrets ? runtimeSecretPaths;
      message = "minutka-secrets.nix must be present before enabling production observability.";
    }
    {
      assertion = lib.hasPrefix "/" minioDataDir;
      message = "Observability requires an absolute MinIO data path.";
    }
    {
      assertion = minioCapacityBytes > minioFilesystemReserveBytes;
      message = "MinIO capacity must exceed the filesystem reserve so the soft threshold is meaningful.";
    }
  ];

  systemd.tmpfiles.rules = [
    "d ${textfileDir} 0755 root root -"
    "d ${stateDir} 0750 minutka minutka -"
  ];

  services.prometheus.exporters.node = {
    enable = true;
    listenAddress = "127.0.0.1";
    enabledCollectors = [ "systemd" "textfile" ];
    extraFlags = [
      "--collector.textfile.directory=${textfileDir}"
      "--collector.filesystem.mount-points-exclude=^/(dev|proc|run/credentials/.+|sys|var/lib/docker/.+)($|/)"
      "--collector.filesystem.fs-types-exclude=^(autofs|binfmt_misc|bpf|cgroup2?|configfs|debugfs|devpts|devtmpfs|efivarfs|fusectl|hugetlbfs|mqueue|nsfs|overlay|proc|pstore|rpc_pipefs|securityfs|sysfs|tmpfs|tracefs)$"
    ];
  };

  systemd.services.minutka-observability-collector = {
    description = "Collect minutka textfile metrics";
    after = [ "postgresql.service" "minutka.service" ];
    wants = [ "postgresql.service" ];

    unitConfig.RequiresMountsFor = minioDataDir;

    serviceConfig = {
      Type = "oneshot";
      User = "root";
      Group = "root";
      ExecStart = lib.getExe collectorScript;
      ReadWritePaths = [ textfileDir ];
      NoNewPrivileges = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      PrivateTmp = true;
      PrivateDevices = true;
      RestrictAddressFamilies = [ "AF_UNIX" ];
    };
  };

  systemd.timers.minutka-observability-collector = {
    description = "Refresh minutka textfile metrics";
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "2m";
      OnUnitActiveSec = "5m";
      Unit = "minutka-observability-collector.service";
    };
  };
}
