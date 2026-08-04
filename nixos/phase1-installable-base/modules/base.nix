{ lib, pkgs, site, ... }:

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
  };

  users.users.root.openssh.authorizedKeys.keys = site.rootAuthorizedKeys;

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
