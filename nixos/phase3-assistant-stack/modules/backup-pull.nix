{ lib, pkgs, site, ... }:

let
  cfg = site.backupPull;
  backupGroup = "minutka";
  keyIdentity = key:
    lib.concatStringsSep " " (lib.take 2 (lib.splitString " " key));
  adminKeyIdentities = map keyIdentity site.adminAuthorizedKeys;
  pullKeyIdentities = map keyIdentity cfg.sshAuthorizedKeys;
in
lib.mkIf cfg.enable {
  users.groups.${cfg.user} = { };

  users.users.${cfg.user} = {
    isSystemUser = true;
    description = "Read-only SSH user for off-site minutka backup pulls";
    group = cfg.user;
    extraGroups = [ backupGroup ];
    home = "/var/lib/${cfg.user}";
    createHome = true;
    shell = pkgs.bashInteractive + "/bin/bash";
    openssh.authorizedKeys.keys = map
      (key: "restrict,command=\"${lib.getExe pkgs.rrsync} -ro /var/backups/minutka\" ${key}")
      cfg.sshAuthorizedKeys;
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
    {
      assertion = builtins.all
        (key: !(builtins.elem key adminKeyIdentities))
        pullKeyIdentities;
      message = "site.backupPull.sshAuthorizedKeys must not reuse an adminAuthorizedKeys identity.";
    }
  ];
}
