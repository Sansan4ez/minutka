{
  system = "x86_64-linux";
  hostName = "personal-assistant-1";
  timeZone = "Etc/UTC";
  locale = "en_US.UTF-8";

  bootMode = "bios"; # or "efi"
  disk = "/dev/sda";

  publicIPv4 = "169.58.116.31";

  deploy = {
    sshUser = "admin";
    sshHost = "169.58.116.31";
    sshTarget = "admin@169.58.116.31";
    sshIdentityFile = "/home/admin/.ssh/id_ed25519";
  };

  adminUser = "admin";

  adminAuthorizedKeys = [
    "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILtxITw5sdJKdp5x+uzAcXVHHFn74yBREgZCazjm0mOC"
  ];

  network = {
    # Keep this in sync with phase1-installable-base/site.nix.
    useDHCP = false;
    interface = "eth0";
    address = "169.58.116.31";
    prefixLength = 17;
    gateway = "169.58.0.1";
    nameservers = [ "1.1.1.1" "8.8.8.8" ];
  };

  storage.minio = {
    # Mount a dedicated durable filesystem here before admitting pilot traffic.
    # 55 GiB = 45 GiB artifact budget + 5 GiB application reserve + 5 GiB
    # filesystem reserve for MinIO versioning/metadata and operational headroom.
    dataDir = "/srv/personal-assistant/minio";
    capacityBytes = 59055800320;
    filesystemReserveBytes = 5368709120;
  };
}
