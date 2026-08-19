{
  system = "x86_64-linux";
  hostName = "minutka-1";
  timeZone = "Etc/UTC";
  locale = "en_US.UTF-8";

  bootMode = "bios"; # or "efi"
  disk = "/dev/sda";

  publicIPv4 = "169.58.201.159";

  deploy = {
    sshUser = "admin";
    sshHost = "169.58.201.159";
    sshTarget = "admin@169.58.201.159";
    sshIdentityFile = "/home/admin/.ssh/id_ed25519";
  };

  adminUser = "admin";

  adminAuthorizedKeys = [
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILtxITw5sdJKdp5x+uzAcXVHHFn74yBREgZCazjm0mOC"
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDIdBSYWtYAjptO95urpYB1k49odiCBvz75iUtFvh/jK"
  ];

  network = {
    # Keep this in sync with phase1-installable-base/site.nix.
    useDHCP = false;
    interface = "eth0";
    address = "169.58.201.159";
    prefixLength = 17;
    gateway = "169.58.128.1";
    nameservers = [ "1.1.1.1" "8.8.8.8" ];
  };
}
