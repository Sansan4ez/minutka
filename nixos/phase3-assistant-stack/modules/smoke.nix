{ lib, pkgs, ... }:

let
  stateDir = "/var/lib/personal-assistant-observability";
  smokeScript = pkgs.writeShellApplication {
    name = "personal-assistant-smoke";
    runtimeInputs = with pkgs; [ coreutils curl systemd ];
    text = ''
      set -euo pipefail

      systemctl is-active --quiet postgresql.service
      systemctl is-active --quiet minio.service
      systemctl is-active --quiet personal-assistant.service
      curl -fsS http://127.0.0.1:8787/healthz >/dev/null

      mkdir -p ${stateDir}
      date -u +%s > ${stateDir}/smoke.last_success

      echo "Personal assistant smoke checks passed"
    '';
  };
in
{
  systemd.tmpfiles.rules = [
    "d ${stateDir} 0750 personal-assistant personal-assistant -"
  ];

  systemd.services.personal-assistant-smoke = {
    description = "Run personal-assistant production smoke checks";
    after = [ "postgresql.service" "minio.service" "personal-assistant.service" ];
    wants = [ "postgresql.service" "minio.service" "personal-assistant.service" ];

    serviceConfig = {
      Type = "oneshot";
      User = "personal-assistant";
      Group = "personal-assistant";
      ExecStart = lib.getExe smokeScript;
      ReadWritePaths = [ stateDir ];
      NoNewPrivileges = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      PrivateTmp = true;
      PrivateDevices = true;
      RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" ];
    };
  };

  systemd.timers.personal-assistant-smoke = {
    description = "Run personal-assistant smoke checks periodically";
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "5m";
      OnUnitActiveSec = "15m";
      Unit = "personal-assistant-smoke.service";
    };
  };
}
