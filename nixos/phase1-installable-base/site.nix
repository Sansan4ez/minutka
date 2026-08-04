{
  system = "x86_64-linux";
  hostName = "personal-assistant-1";
  timeZone = "Etc/UTC";
  locale = "en_US.UTF-8";

  bootMode = "bios"; # or "efi"
  disk = "/dev/sda";

  publicIPv4 = "169.58.116.31";
  adminUser = "admin";

  deploy = {
    sshUser = "root";
    sshHost = "169.58.116.31";
    sshTarget = "root@169.58.116.31";
    sshIdentityFile = "/home/admin/.ssh/id_ed25519";
  };

  rootAuthorizedKeys = [
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILtxITw5sdJKdp5x+uzAcXVHHFn74yBREgZCazjm0mOC"
  ];

  network = {
    # DHCP is the safest default until the VPS provider's static network
    # parameters are copied here. Set useDHCP = false and replace every
    # placeholder below before selecting static networking.
    useDHCP = false;
    interface = "eth0";
    address = "169.58.116.31";
    prefixLength = 17;
    gateway = "169.58.0.1";
    nameservers = [ "1.1.1.1" "8.8.8.8" ];
  };
}
