{
  system = "x86_64-linux";
  hostName = "personal-assistant-1";
  timeZone = "Europe/Amsterdam";
  locale = "en_US.UTF-8";

  bootMode = "bios"; # or "efi"
  disk = "/dev/vda";

  publicIPv4 = "REPLACE_ME_SERVER_IP";

  deploy = {
    sshUser = "root";
    sshHost = "REPLACE_ME_SERVER_IP";
    sshTarget = "root@REPLACE_ME_SERVER_IP";
    sshIdentityFile = "/home/admin/.ssh/id_ed25519";
  };

  rootAuthorizedKeys = [
    "REPLACE_ME_SSH_PUBLIC_KEY"
  ];

  network = {
    # DHCP is the safest default until the VPS provider's static network
    # parameters are copied here. Set useDHCP = false and replace every
    # placeholder below before selecting static networking.
    useDHCP = true;
    interface = "REPLACE_ME_INTERFACE";
    address = "REPLACE_ME_SERVER_IP";
    prefixLength = 24;
    gateway = "REPLACE_ME_GATEWAY";
    nameservers = [ "1.1.1.1" "8.8.8.8" ];
  };
}
