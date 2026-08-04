{ site, ... }:

{
  imports = [
    (if site.network.useDHCP then ./networking-dhcp.nix else ./networking-static.nix)
  ];
}
