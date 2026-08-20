{ lib, site, ... }:

{
  imports =
    [
      ../../modules/base.nix
      ../../modules/boot.nix
      ../../modules/networking.nix
      ../../modules/firewall.nix
      ../../modules/ssh.nix
      ../../modules/ops-runtime.nix
      ../../modules/minutka-secrets.nix
      ../../modules/cliproxyapi.nix
      ../../modules/postgres.nix
      ../../modules/minio.nix
      ../../modules/minutka.nix
      ../../modules/backup.nix
      ../../modules/backup-pull.nix
      ../../modules/smoke.nix
      ../../modules/observability.nix
      ../../modules/alerting.nix
    ]
    ++ lib.optionals (builtins.pathExists ./hardware-configuration.nix) [
      ./hardware-configuration.nix
    ];

  networking.hostName = site.hostName;

  system.stateVersion = "25.11";
}
