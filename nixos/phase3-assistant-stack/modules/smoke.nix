{ lib, pkgs, ... }:

let
  stateDir = "/var/lib/minutka-observability";
  smokeScript = pkgs.writeShellApplication {
    name = "minutka-smoke";
    runtimeInputs = with pkgs; [ coreutils curl systemd ];
    text = ''
      set -euo pipefail

      systemctl is-active --quiet postgresql.service
      systemctl is-active --quiet minio.service
      systemctl is-active --quiet minutka.service
      curl -fsS http://127.0.0.1:8787/healthz >/dev/null

      mkdir -p ${stateDir}
      date -u +%s > ${stateDir}/smoke.last_success

      echo "Minutka smoke checks passed"
    '';
  };
in
{
  systemd.tmpfiles.rules = [
    "d ${stateDir} 0750 minutka minutka -"
  ];

  systemd.services.minutka-smoke = {
    description = "Run minutka production smoke checks";
    after = [ "postgresql.service" "minio.service" "minutka.service" ];
    wants = [ "postgresql.service" "minio.service" "minutka.service" ];

    serviceConfig = {
      Type = "oneshot";
      User = "minutka";
      Group = "minutka";
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

  systemd.timers.minutka-smoke = {
    description = "Run minutka smoke checks periodically";
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnBootSec = "5m";
      OnUnitActiveSec = "15m";
      Unit = "minutka-smoke.service";
    };
  };
}
