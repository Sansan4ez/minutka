{ lib, personalAssistantPackage, personalAssistantSecrets, ... }:

let
  appDir = "${personalAssistantPackage}/lib/personal-assistant";
  environment = {
    LLM_MODEL = "openai/11qiw/gpt-5.5";
    OPENAI_BASE_URL = "http://127.0.0.1:8317/v1";
    STT_PROVIDER = "openai";
    STT_BASE_URL = "https://openrouter.ai/api/v1";
    MINUTKA_API_HOST = "127.0.0.1";
    MINUTKA_API_PORT = "8787";
    TELEGRAM_MODE = "polling";
    PRIVACY_POLICY_V4_URL = "https://sansan4ez.github.io/privacy-v4.html";

    DATABASE_SSL_MODE = "disable";
    MINIO_ENDPOINT = "127.0.0.1";
    MINIO_PORT = "9000";
    MINIO_USE_SSL = "false";
    MINIO_BUCKET = "personal-assistant";

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

    ASSISTANT_CONTEXT_TOTAL_CHARACTERS = "88000";
    ASSISTANT_CONTEXT_RESPONSE_RESERVE_CHARACTERS = "8000";
    ASSISTANT_CONTEXT_SOURCE_AGENT_MANUAL_CHARACTERS = "32000";
    ASSISTANT_CONTEXT_SOURCE_PROFILE_CHARACTERS = "4000";
    ASSISTANT_CONTEXT_SOURCE_CONTEXT_CHARACTERS = "24000";
    ASSISTANT_CONTEXT_SOURCE_CONTEXT_INDEX_CHARACTERS = "6000";
    ASSISTANT_CONTEXT_SOURCE_RECORDS_CHARACTERS = "12000";
    ASSISTANT_CONTEXT_SOURCE_THREAD_SUMMARY_CHARACTERS = "4000";
    ASSISTANT_CONTEXT_SOURCE_HISTORY_CHARACTERS = "12000";
    ASSISTANT_CONTEXT_DOCUMENTS = "5";
    ASSISTANT_CONTEXT_DOCUMENT_CHARACTERS = "8000";
    ASSISTANT_CONTEXT_INDEX_DEPTH = "4";
    ASSISTANT_CONTEXT_RECORDS = "24";
    ASSISTANT_CONTEXT_RECORD_CHARACTERS = "1000";
    ASSISTANT_CONTEXT_HISTORY_TURNS = "10";
    ASSISTANT_CONTEXT_HISTORY_TURN_CHARACTERS = "6000";
    ASSISTANT_CONTEXT_THREAD_SUMMARY_CHARACTERS = "4000";
    ASSISTANT_CONTEXT_THREAD_COMPACTION_TURNS = "10";
    ASSISTANT_CONTEXT_THREAD_COMPACTION_FIELD_CHARACTERS = "2000";
    ASSISTANT_CONTEXT_ROUTING_TURNS = "3";
    ASSISTANT_CONTEXT_ROUTING_CURRENT_TEXT_CHARACTERS = "4096";
    ASSISTANT_CONTEXT_ROUTING_TURN_FIELD_CHARACTERS = "700";
    ASSISTANT_CONTEXT_INSIGHT_TURNS = "5";
    ASSISTANT_CONTEXT_INSIGHT_FIELD_CHARACTERS = "2000";
    ASSISTANT_CONTEXT_INSIGHTS = "20";
    ASSISTANT_CONTEXT_FEEDBACK = "20";
    ASSISTANT_CONTEXT_RUN_CURRENT = "50";
    ASSISTANT_CONTEXT_RUN_RECENT = "50";
  };
in
{
  assertions = [
    {
      assertion = personalAssistantSecrets ? environmentFile;
      message = "assistant-secrets.nix must provide the personal-assistant EnvironmentFile.";
    }
  ];

  systemd.services.personal-assistant = {
    description = "Personal AI assistant";
    wantedBy = [ "multi-user.target" ];
    after = [
      "network-online.target"
      "cliproxyapi.service"
      "personal-assistant-postgres-migrate.service"
      "personal-assistant-minio-provision.service"
    ];
    requires = [
      "cliproxyapi.service"
      "personal-assistant-postgres-migrate.service"
      "personal-assistant-minio-provision.service"
    ];
    wants = [ "network-online.target" ];

    environment = environment;

    serviceConfig = {
      Type = "simple";
      User = "personal-assistant";
      Group = "personal-assistant";
      WorkingDirectory = appDir;
      ExecStart = lib.getExe personalAssistantPackage;
      EnvironmentFile = personalAssistantSecrets.environmentFile;
      Restart = "always";
      RestartSec = 5;

      StandardOutput = "journal";
      StandardError = "journal";
      SyslogIdentifier = "personal-assistant";

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
