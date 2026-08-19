{ lib, site, ... }:

{
  imports =
    [
      ../../modules/base.nix
      ../../modules/boot.nix
      ../../modules/networking.nix
      ../../modules/ssh.nix
    ]
    ++ lib.optionals (builtins.pathExists ./hardware-configuration.nix) [
      ./hardware-configuration.nix
    ];

  networking.hostName = site.hostName;

  system.stateVersion = "25.11";
}
