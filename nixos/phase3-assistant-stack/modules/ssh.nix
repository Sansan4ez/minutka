{
  services.openssh = {
    enable = true;
    settings = {
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      PermitRootLogin = "no";
      AllowTcpForwarding = "local";
      X11Forwarding = false;
      LogLevel = "VERBOSE";
    };
  };

  services.fail2ban = {
    enable = true;
    jails.sshd.settings = {
      maxretry = 5;
      findtime = "10m";
      bantime = "1h";
    };
  };
}
