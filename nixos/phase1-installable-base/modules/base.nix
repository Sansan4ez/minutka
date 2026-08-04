{ lib, pkgs, site, ... }:

let
  adminUser = if site ? adminUser then site.adminUser else "admin";
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

  users.users = {
    root.openssh.authorizedKeys.keys = site.rootAuthorizedKeys;

    ${adminUser} = {
      isNormalUser = true;
      description = "Administrative deployment user";
      extraGroups = [ "wheel" ];
      openssh.authorizedKeys.keys = site.rootAuthorizedKeys;
    };
  };

  security.sudo = {
    enable = true;
    wheelNeedsPassword = false;
    execWheelOnly = true;
  };

  environment.systemPackages = with pkgs; [
    curl
  ];

  assertions = [
    {
      assertion = !(lib.hasInfix "REPLACE_ME" site.deploy.sshHost);
      message = "Replace deploy SSH host placeholders in phase1-installable-base/site.nix before deployment.";
    }
    {
      assertion = site.network.useDHCP || !(builtins.any (value: lib.hasInfix "REPLACE_ME" value) [
        site.network.interface
        site.network.address
        site.network.gateway
      ]);
      message = "Replace static network placeholders in phase1-installable-base/site.nix before deployment.";
    }
    {
      assertion = !(builtins.any (key: lib.hasInfix "REPLACE_ME" key) site.rootAuthorizedKeys);
      message = "Replace rootAuthorizedKeys in phase1-installable-base/site.nix before deployment.";
    }
  ];
}
