{ lib, pkgs, minutkaPackage, minutkaSecrets, sourceCommit, ... }:

let
  reportsDir = "/var/lib/minutka-reports";
  reportOutput = "${reportsDir}/pilot-status-latest.html";
  observabilityDir = "/var/lib/minutka-observability";
  backupsDir = "/var/backups/minutka";
  appDir = "${minutkaPackage}/lib/minutka";
  generator = pkgs.writeShellApplication {
    name = "minutka-generate-pilot-status";
    runtimeInputs = with pkgs; [ coreutils curl findutils systemd ];
    text = ''
      set -euo pipefail
      output=${lib.escapeShellArg reportOutput}
      commit=${lib.escapeShellArg sourceCommit}
      backup_id="$(find ${backupsDir} -mindepth 1 -maxdepth 1 -type d -not -name '*.incomplete' -printf '%f\n' 2>/dev/null | sort | tail -n 1)"
      if [ -s ${observabilityDir}/smoke.last_success ]; then smoke="passed"; else smoke="missing"; fi
      unit_status() { if systemctl is-active --quiet "$1"; then printf active; else printf failed; fi; }

      exec ${minutkaPackage}/bin/minutka-pilot-status \
        --output "$output" \
        --template "${appDir}/docs/reports/pilot-status-template.html" \
        --commit "$commit" \
        --backup-id "$backup_id" \
        --smoke "$smoke" \
        --unit "minutka=$(unit_status minutka.service)" \
        --unit "postgresql=$(unit_status postgresql.service)" \
        --unit "minio=$(unit_status minio.service)" \
        --unit "cliproxyapi=$(unit_status cliproxyapi.service)"
    '';
  };
in
{
  # setgid: generated reports inherit group `users`, so the operator reads them
  # over SSH without sudo while the directory stays closed to everyone else.
  systemd.tmpfiles.rules = [
    "d ${reportsDir} 2750 minutka users -"
  ];

  environment.systemPackages = [ generator ];

  systemd.services.minutka-pilot-status = {
    description = "Generate the internal Minutka pilot status report";
    after = [ "minutka.service" "postgresql.service" "minio.service" "minutka-smoke.service" ];
    wants = [ "minutka.service" "postgresql.service" "minio.service" ];

    environment = {
      DATABASE_SSL_MODE = "disable";
    };

    serviceConfig = {
      Type = "oneshot";
      User = "minutka";
      Group = "minutka";
      EnvironmentFile = minutkaSecrets.environmentFile;
      ExecStart = lib.getExe generator;
      ReadWritePaths = [ reportsDir ];
      NoNewPrivileges = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      PrivateTmp = true;
      PrivateDevices = true;
      RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
    };
  };

  systemd.timers.minutka-pilot-status = {
    description = "Generate the Minutka pilot status twice daily";
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnCalendar = [ "*-*-* 08:15:00 UTC" "*-*-* 17:15:00 UTC" ];
      Persistent = true;
      RandomizedDelaySec = "5m";
      Unit = "minutka-pilot-status.service";
    };
  };
}
