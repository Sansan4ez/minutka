{ lib, site, ... }:

{
  boot.loader.grub = {
    enable = true;
    efiSupport = false;
    device = lib.mkForce "";
    devices = lib.mkForce [ site.disk ];
  };
}
