{ lib, site, ... }:

let
  adminUser = if site ? adminUser then site.adminUser else "admin";
  adminAuthorizedKeys = site.adminAuthorizedKeys;
in
{
  time.timeZone = site.timeZone;
  i18n.defaultLocale = site.locale;

  documentation = {
    enable = false;
    info.enable = false;
    man.enable = false;
    nixos.enable = false;
  };

  nix.settings = {
    experimental-features = [ "nix-command" "flakes" ];
    auto-optimise-store = true;
    trusted-users = [ "root" adminUser ];
  };

  users.users.${adminUser} = {
    isNormalUser = true;
    description = "Administrative user";
    extraGroups = [ "wheel" ];
    openssh.authorizedKeys.keys = adminAuthorizedKeys;
    homeMode = "0710";
  };
  users.groups.users.members = lib.mkAfter [ "personal-assistant" ];

  users.groups.personal-assistant = { };
  users.users.personal-assistant = {
    isSystemUser = true;
    group = "personal-assistant";
    description = "Personal assistant service";
  };

  security.sudo = {
    enable = true;
    wheelNeedsPassword = false;
    execWheelOnly = true;
  };

  assertions = [
    {
      assertion = !(lib.hasInfix "REPLACE_ME" site.deploy.sshHost);
      message = "Replace deploy SSH host placeholders in phase2-ops-base/site.nix before deployment.";
    }
    {
      assertion = site.network.useDHCP || !(builtins.any (value: lib.hasInfix "REPLACE_ME" value) [
        site.network.interface
        site.network.address
        site.network.gateway
      ]);
      message = "Replace static network placeholders in phase2-ops-base/site.nix before deployment.";
    }
    {
      assertion = !(builtins.any (key: lib.hasInfix "REPLACE_ME" key) site.adminAuthorizedKeys);
      message = "Replace adminAuthorizedKeys in phase2-ops-base/site.nix before deployment.";
    }
  ];
}
