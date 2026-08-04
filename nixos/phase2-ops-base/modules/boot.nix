{ site, ... }:

{
  imports = [
    (if site.bootMode == "efi" then ./boot-efi.nix else ./boot-bios.nix)
  ];
}
