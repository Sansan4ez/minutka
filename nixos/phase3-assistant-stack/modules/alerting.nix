{ lib, pkgs, minutkaSecrets, ... }:

let
  stateDir = "/var/lib/minutka-alerting";
  promFile = "/var/lib/node-exporter-textfile/minutka.prom";

  # Anti-flap window: 4 hours (14400 seconds).
  antiFlap = 14400;

  # Thresholds from docs/runbooks/production-observability.md.
  smokeMaxAgeSec = 1800;   # 30 minutes
  backupMaxAgeSec = 86400; # 24 hours

  botTokenPath = minutkaSecrets.runtimeSecretPaths.ops_telegram_bot_token;
  chatIdPath = minutkaSecrets.runtimeSecretPaths.ops_telegram_chat_id;

  alertScript = pkgs.writeShellApplication {
    name = "minutka-alerting";
    runtimeInputs = with pkgs; [ coreutils gnugrep gawk curl ];
    text = ''
      set -euo pipefail

      PROM_FILE="${promFile}"
      STATE_DIR="${stateDir}"
      ANTI_FLAP="${toString antiFlap}"

      BOT_TOKEN="$(tr -d '[:space:]' < "${botTokenPath}")"
      CHAT_ID="$(tr -d '[:space:]' < "${chatIdPath}")"

      if [ -z "$BOT_TOKEN" ] || [ -z "$CHAT_ID" ]; then
        echo "Missing ops Telegram credentials, skipping alerting"
        exit 0
      fi

      NOW="$(date -u +%s)"

      # Parse a metric value from the .prom textfile.
      # Usage: metric_value <name> [label_match]
      # label_match is a fixed string inside the braces, e.g. unit="minutka.service"
      metric_value() {
        local name="$1"
        local labels="''${2:-}"
        local line
        if [ -n "$labels" ]; then
          line="$(grep "^''${name}{''${labels}}" "$PROM_FILE" 2>/dev/null | head -1)" || true
        else
          line="$(grep "^''${name} " "$PROM_FILE" 2>/dev/null | head -1)" || true
        fi
        if [ -n "$line" ]; then
          awk '{print $NF}' <<< "$line"
        fi
      }

      # Anti-flap guard: returns 0 (true) if enough time has passed since the
      # last alert for this signal, 1 (false) otherwise.
      should_alert() {
        local signal="$1"
        local state_file="''${STATE_DIR}/''${signal}.last_alert"
        if [ -f "$state_file" ]; then
          local last_alert
          last_alert="$(cat "$state_file")"
          if [[ "$last_alert" =~ ^[0-9]+$ ]] && [ $((NOW - last_alert)) -lt "$ANTI_FLAP" ]; then
            return 1
          fi
        fi
        return 0
      }

      record_alert() {
        local signal="$1"
        echo "$NOW" > "''${STATE_DIR}/''${signal}.last_alert"
      }

      send_alert() {
        local signal="$1"
        local message="$2"
        if should_alert "$signal"; then
          curl -fsS -X POST \
            "https://api.telegram.org/bot''${BOT_TOKEN}/sendMessage" \
            -d "chat_id=''${CHAT_ID}" \
            --data-urlencode "text=''${message}" \
            > /dev/null
          record_alert "$signal"
          echo "Alert sent: ''${signal}"
        else
          echo "Anti-flap active: ''${signal}"
        fi
      }

      # --- Guard: .prom file must exist ---
      if [ ! -f "$PROM_FILE" ]; then
        send_alert "prom_file_missing" "$(printf '⚠️ Minutka alerting: metrics file missing (%s)' "$PROM_FILE")"
        exit 0
      fi

      # --- 1. minutka.service down ---
      unit_active="$(metric_value minutka_systemd_unit_active 'unit="minutka.service"')"
      if [ "''${unit_active:-1}" = "0" ]; then
        send_alert "unit_down" "$(printf '🔴 Minutka: minutka.service is not active')"
      fi

      # --- 2. Smoke stale (> 30 min) ---
      smoke_ts="$(metric_value minutka_smoke_last_success_timestamp_seconds)"
      if [ -n "$smoke_ts" ] && [ "''${smoke_ts%.*}" != "0" ]; then
        smoke_age=$((NOW - ''${smoke_ts%.*}))
        if [ "$smoke_age" -gt ${toString smokeMaxAgeSec} ]; then
          send_alert "smoke_stale" "$(printf '🟡 Minutka: smoke check stale (%d min ago)' "$((smoke_age / 60))")"
        fi
      elif [ "''${smoke_ts:-0}" = "0" ]; then
        send_alert "smoke_never" "$(printf '🟡 Minutka: smoke check has never succeeded')"
      fi

      # --- 3. Backup stale (> 24h) ---
      backup_ts="$(metric_value minutka_backup_last_success_timestamp_seconds)"
      if [ -n "$backup_ts" ] && [ "''${backup_ts%.*}" != "0" ]; then
        backup_age=$((NOW - ''${backup_ts%.*}))
        if [ "$backup_age" -gt ${toString backupMaxAgeSec} ]; then
          send_alert "backup_stale" "$(printf '🟡 Minutka: backup stale (%dh ago)' "$((backup_age / 3600))")"
        fi
      fi

      # --- 4. MinIO capacity soft threshold exceeded ---
      minio_exceeded="$(metric_value minutka_minio_capacity_soft_threshold_exceeded)"
      if [ "''${minio_exceeded:-0}" = "1" ]; then
        send_alert "minio_capacity" "$(printf '🟠 Minutka: MinIO capacity soft threshold exceeded')"
      fi

      # --- 5. Artifact owner soft quota exceeded ---
      owner_exceeded="$(metric_value minutka_artifact_owner_soft_quota_exceeded_count)"
      if [ -n "$owner_exceeded" ] && [ "''${owner_exceeded:-0}" != "0" ]; then
        send_alert "artifact_owner_quota" "$(printf '🟠 Minutka: %s owner(s) at or above soft artifact quota' "$owner_exceeded")"
      fi

      echo "Alerting check completed"
    '';
  };
in
{
  assertions = [
    {
      assertion = minutkaSecrets ? runtimeSecretPaths;
      message = "minutka-secrets.nix must be present before enabling alerting.";
    }
  ];

  systemd.tmpfiles.rules = [
    "d ${stateDir} 0750 root root -"
  ];

  systemd.services.minutka-alerting = {
    description = "Check minutka metrics and alert operator via Telegram";
    after = [ "minutka-observability-collector.service" "network-online.target" ];
    wants = [ "network-online.target" ];

    serviceConfig = {
      Type = "oneshot";
      User = "root";
      Group = "root";
      ExecStart = lib.getExe alertScript;
      ReadWritePaths = [ stateDir ];
      NoNewPrivileges = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      PrivateTmp = true;
      PrivateDevices = true;
      RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
    };
  };

  systemd.timers.minutka-alerting = {
    description = "Run minutka alerting checks periodically";
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "7m";
      OnUnitActiveSec = "10m";
      Unit = "minutka-alerting.service";
    };
  };
}
