{
  system = "x86_64-linux";
  hostName = "personal-assistant-1";
  timeZone = "Europe/Amsterdam";
  locale = "en_US.UTF-8";

  bootMode = "bios"; # or "efi"
  disk = "/dev/vda";

  publicIPv4 = "REPLACE_ME_SERVER_IP";

  deploy = {
    sshUser = "admin";
    sshHost = "REPLACE_ME_SERVER_IP";
    sshTarget = "admin@REPLACE_ME_SERVER_IP";
    sshIdentityFile = "/home/admin/.ssh/id_ed25519";
  };

  adminUser = "admin";

  adminAuthorizedKeys = [
    "REPLACE_ME_SSH_PUBLIC_KEY"
  ];

  network = {
    # Keep this in sync with phase1-installable-base/site.nix.
    useDHCP = true;
    interface = "REPLACE_ME_INTERFACE";
    address = "REPLACE_ME_SERVER_IP";
    prefixLength = 24;
    gateway = "REPLACE_ME_GATEWAY";
    nameservers = [ "1.1.1.1" "8.8.8.8" ];
  };
}
