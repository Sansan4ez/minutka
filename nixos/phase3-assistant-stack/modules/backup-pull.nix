{ lib, pkgs, site, ... }:

let
  cfg = site.backupPull;
  backupGroup = "personal-assistant";
in
lib.mkIf cfg.enable {
  users.groups.${cfg.user} = { };

  users.users.${cfg.user} = {
    isSystemUser = true;
    description = "Read-only SSH user for off-site personal-assistant backup pulls";
    group = cfg.user;
    extraGroups = [ backupGroup ];
    home = "/var/lib/${cfg.user}";
    createHome = true;
    shell = pkgs.bashInteractive + "/bin/bash";
    openssh.authorizedKeys.keys = cfg.sshAuthorizedKeys;
  };

  assertions = [
    {
      assertion = builtins.length cfg.sshAuthorizedKeys > 0;
      message = "Configure site.backupPull.sshAuthorizedKeys before deploying the production backup pull user.";
    }
    {
      assertion = !(builtins.any (key: lib.hasInfix "REPLACE_ME" key) cfg.sshAuthorizedKeys);
      message = "Replace placeholder values in site.backupPull.sshAuthorizedKeys before deployment.";
    }
  ];
}
