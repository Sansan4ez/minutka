{ lib, pkgs, personalAssistantSecrets, ... }:

let
  version = "7.2.110";
  source = pkgs.fetchurl {
    url = "https://github.com/router-for-me/CLIProxyAPI/releases/download/v${version}/CLIProxyAPI_${version}_linux_amd64.tar.gz";
    hash = "sha256-ZVBDhmEa9yLCsQOm9/uzjv0tGCJlgAigN5fnbk9r9zg=";
  };
  package = pkgs.runCommand "cliproxyapi-${version}" {
    nativeBuildInputs = [ pkgs.autoPatchelfHook ];
    buildInputs = [ pkgs.glibc ];
  } ''
    mkdir -p "$out/bin" "$out/share/cliproxyapi"
    tar -xzf ${source} -C "$out/share/cliproxyapi"
    install -m 0755 "$out/share/cliproxyapi/cli-proxy-api" "$out/bin/cli-proxy-api"
    autoPatchelf "$out/bin/cli-proxy-api"
  '';
  stateDir = "/var/lib/cliproxyapi";
in
{
  assertions = [
    {
      assertion = personalAssistantSecrets ? cliproxyConfigFile;
      message = "assistant-secrets.nix must provide the CLIProxyAPI config file.";
    }
  ];

  users.groups.cliproxyapi = { };
  users.users.cliproxyapi = {
    isSystemUser = true;
    group = "cliproxyapi";
    home = stateDir;
    createHome = true;
    description = "Local OpenAI-compatible CLI proxy";
  };

  systemd.tmpfiles.rules = [
    "d ${stateDir} 0750 cliproxyapi cliproxyapi -"
    "d ${stateDir}/.cli-proxy-api 0700 cliproxyapi cliproxyapi -"
  ];

  systemd.services.cliproxyapi = {
    description = "CLIProxyAPI local LLM gateway";
    wantedBy = [ "multi-user.target" ];
    after = [ "network-online.target" ];
    wants = [ "network-online.target" ];

    serviceConfig = {
      Type = "simple";
      User = "cliproxyapi";
      Group = "cliproxyapi";
      WorkingDirectory = stateDir;
      Environment = "HOME=${stateDir}";
      ExecStart = "${lib.getExe' package "cli-proxy-api"} -config ${stateDir}/config.yaml";
      ExecStartPre = "${pkgs.coreutils}/bin/install -m 0600 -o cliproxyapi -g cliproxyapi ${personalAssistantSecrets.cliproxyConfigFile} ${stateDir}/config.yaml";
      Restart = "always";
      RestartSec = 5;
      StateDirectory = "cliproxyapi";
      StateDirectoryMode = "0750";
      UMask = "0077";
      NoNewPrivileges = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      PrivateTmp = true;
      PrivateDevices = true;
      RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
      ReadWritePaths = [ stateDir ];
    };
  };
}
