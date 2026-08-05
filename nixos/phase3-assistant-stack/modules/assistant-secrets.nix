{ lib, config, ... }:

let
  secretFile = ../secrets/assistant.yaml;
  placeholderMarkers = [ "change-me" "REPLACE_ME" ];
  secretFileText = builtins.readFile secretFile;
  containsPlaceholder = marker: lib.hasInfix marker secretFileText;

  environmentSecrets = {
    openai_api_key = "OPENAI_API_KEY";
    stt_api_key = "STT_API_KEY";
    telegram_bot_token = "TELEGRAM_BOT_TOKEN";
    minutka_service_token = "MINUTKA_SERVICE_TOKEN";
    minutka_admin_token = "MINUTKA_ADMIN_TOKEN";
    integration_enc_key = "INTEGRATION_ENC_KEY";
    invite_code_pepper = "INVITE_CODE_PEPPER";
    telegram_identity_pepper = "TELEGRAM_IDENTITY_PEPPER";
    minio_access_key = "MINIO_ACCESS_KEY";
    minio_secret_key = "MINIO_SECRET_KEY";
    database_url = "DATABASE_URL";
    migration_database_url = "MIGRATION_DATABASE_URL";
  };

  infrastructureSecrets = {
    minio_root_user = "MINIO_ROOT_USER";
    minio_root_password = "MINIO_ROOT_PASSWORD";
    minutka_api_token = "MINUTKA_API_TOKEN";
    postgres_superuser_password = "POSTGRES_SUPERUSER_PASSWORD";
    minutka_db_password = "MINUTKA_DB_PASSWORD";
    minutka_migrator_db_password = "MINUTKA_MIGRATOR_DB_PASSWORD";
  };

  allSecrets = environmentSecrets // infrastructureSecrets;
  encryptionMarkerCount = builtins.length (lib.splitString "ENC[AES256_GCM" secretFileText) - 1;
  expectedEncryptionMarkerCount = builtins.length (builtins.attrNames allSecrets) + 1; # values + sops.mac
  secretPath = name: "assistant/${name}";
  placeholders = lib.mapAttrs'
    (name: _: lib.nameValuePair name config.sops.placeholder.${secretPath name})
    allSecrets;
  environmentLines = lib.mapAttrsToList
    (name: environmentName: "${environmentName}=${placeholders.${name}}")
    environmentSecrets;
  runtimeSecretPaths = lib.mapAttrs
    (name: _: config.sops.secrets.${secretPath name}.path)
    allSecrets;
  minioRootCredentialLines = [
    "MINIO_ROOT_USER=${placeholders.minio_root_user}"
    "MINIO_ROOT_PASSWORD=${placeholders.minio_root_password}"
  ];
in
lib.mkMerge [
  {
    assertions = [
      {
        assertion = builtins.pathExists secretFile;
        message = "Create phase3-assistant-stack/secrets/assistant.yaml and encrypt it with sops before deployment.";
      }
    ];
  }

  (lib.mkIf (builtins.pathExists secretFile) {
    _module.args.personalAssistantSecrets = {
      environmentFile = config.sops.templates."personal-assistant.env".path;
      minioRootCredentialsFile = config.sops.templates."minio-root.env".path;
      inherit runtimeSecretPaths;
    };

    assertions = [
      {
        assertion = encryptionMarkerCount >= expectedEncryptionMarkerCount;
        message = "secrets/assistant.yaml must be a fully sops-encrypted document; plaintext or partially encrypted bundles are refused.";
      }
      {
        assertion = !(builtins.any containsPlaceholder placeholderMarkers);
        message = "Replace every change-me/REPLACE_ME placeholder in secrets/assistant.yaml and re-encrypt it before deployment.";
      }
    ];

    sops = {
      defaultSopsFile = secretFile;
      defaultSopsFormat = "yaml";
      age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];

      secrets = lib.mapAttrs'
        (name: _: lib.nameValuePair (secretPath name) {
          owner = "personal-assistant";
          group = "personal-assistant";
          mode = "0400";
        })
        allSecrets;

      templates = {
        "personal-assistant.env" = {
          owner = "personal-assistant";
          group = "personal-assistant";
          mode = "0400";
          content = lib.concatStringsSep "\n" environmentLines + "\n";
        };

        "minio-root.env" = {
          owner = "minio";
          group = "minio";
          mode = "0400";
          content = lib.concatStringsSep "\n" minioRootCredentialLines + "\n";
        };
      };
    };
  })
]
