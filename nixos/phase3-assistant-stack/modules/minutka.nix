{ lib, minutkaPackage, minutkaSecrets, ... }:

let
  appDir = "${minutkaPackage}/lib/minutka";
  environment = {
    LLM_MODEL = "openai/nath/gpt-5.6-terra";
    OPENAI_BASE_URL = "http://127.0.0.1:8317/v1";
    STT_PROVIDER = "openai";
    STT_BASE_URL = "https://openrouter.ai/api/v1";
    MINUTKA_API_HOST = "127.0.0.1";
    MINUTKA_API_PORT = "8787";
    TELEGRAM_MODE = "polling";
    PRIVACY_POLICY_V6_URL = "https://sansan4ez.github.io/privacy-v6.html";

    DATABASE_SSL_MODE = "disable";
    MINIO_ENDPOINT = "127.0.0.1";
    MINIO_PORT = "9000";
    MINIO_USE_SSL = "false";
    MINIO_BUCKET = "minutka";

    ASSISTANT_USAGE_MONTHLY_SOFT_LIMIT_USD = "30";
    ASSISTANT_USAGE_INPUT_USD_PER_MILLION_TOKENS = "5";
    ASSISTANT_USAGE_CACHED_INPUT_USD_PER_MILLION_TOKENS = "0.5";
    ASSISTANT_USAGE_OUTPUT_USD_PER_MILLION_TOKENS = "30";

    ASSISTANT_ARTIFACT_MAXIMUM_BYTES = "104857600";
    ASSISTANT_ARTIFACT_SAVE_TIMEOUT_MS = "60000";
    ASSISTANT_ARTIFACT_OWNER_SOFT_QUOTA_BYTES = "2147483648";
    ASSISTANT_ARTIFACT_OWNER_HARD_QUOTA_BYTES = "3221225472";
    ASSISTANT_ARTIFACT_GLOBAL_HARD_QUOTA_BYTES = "48318382080";
    ASSISTANT_ARTIFACT_INFRASTRUCTURE_RESERVE_BYTES = "5368709120";

    # Canonical context defaults live in src/application/context-budget.ts and are
    # validated at startup; production inherits them instead of restating them.
    # The cleaned pilot knowledge base was calibrated with 5 priority documents
    # pushed on every turn (default 12); the file index and document tools cover
    # the rest.
    ASSISTANT_CONTEXT_DOCUMENTS = "5";
  };
in
{
  assertions = [
    {
      assertion = minutkaSecrets ? environmentFile;
      message = "minutka-secrets.nix must provide the minutka EnvironmentFile.";
    }
  ];

  systemd.services.minutka = {
    description = "Minutka research assistant";
    wantedBy = [ "multi-user.target" ];
    after = [
      "network-online.target"
      "cliproxyapi.service"
      "minutka-postgres-migrate.service"
      "minutka-minio-provision.service"
    ];
    requires = [
      "cliproxyapi.service"
      "minutka-postgres-migrate.service"
      "minutka-minio-provision.service"
    ];
    wants = [ "network-online.target" ];

    environment = environment;

    serviceConfig = {
      Type = "simple";
      User = "minutka";
      Group = "minutka";
      WorkingDirectory = appDir;
      ExecStart = lib.getExe minutkaPackage;
      EnvironmentFile = minutkaSecrets.environmentFile;
      Restart = "always";
      RestartSec = 5;

      StandardOutput = "journal";
      StandardError = "journal";
      SyslogIdentifier = "minutka";

      NoNewPrivileges = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      PrivateTmp = true;
      PrivateDevices = true;
      RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ];
    };
  };

  services.journald.extraConfig = ''
    SystemMaxUse=512M
  '';
}
