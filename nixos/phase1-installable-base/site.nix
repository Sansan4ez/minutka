{
  system = "x86_64-linux";
  hostName = "minutka-1";
  timeZone = "Etc/UTC";
  locale = "en_US.UTF-8";

  bootMode = "bios"; # or "efi"
  disk = "/dev/sda";

  publicIPv4 = "169.58.201.159";
  adminUser = "admin";

  deploy = {
    sshUser = "root";
    sshHost = "169.58.201.159";
    sshTarget = "root@169.58.201.159";
    sshIdentityFile = "/home/admin/.ssh/id_ed25519";
  };

  rootAuthorizedKeys = [
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILtxITw5sdJKdp5x+uzAcXVHHFn74yBREgZCazjm0mOC"
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDIdBSYWtYAjptO95urpYB1k49odiCBvz75iUtFvh/jK"
  ];

  network = {
    # DHCP is the safest default until the VPS provider's static network
    # parameters are copied here. Set useDHCP = false and replace every
    # placeholder below before selecting static networking.
    useDHCP = false;
    interface = "eth0";
    address = "169.58.201.159";
    prefixLength = 17;
    gateway = "169.58.128.1";
    nameservers = [ "1.1.1.1" "8.8.8.8" ];
  };
}
