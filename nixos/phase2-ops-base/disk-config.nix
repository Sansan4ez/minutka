{ site, ... }:

{
  imports = [
    (if site.bootMode == "efi" then ./disk-config-efi.nix else ./disk-config-bios.nix)
  ];
}
