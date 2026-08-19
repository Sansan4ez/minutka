{ lib, config, ... }:

let
  secretFile = ../secrets/minutka.yaml;
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
    cliproxy_management_key = "CLIPROXY_MANAGEMENT_KEY";
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
  secretPath = name: "minutka/${name}";
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
  backupPgpassLine = "localhost:5432:minutka:minutka_migrator:${placeholders.minutka_migrator_db_password}";
  cliproxyConfig = ''
    host: "127.0.0.1"
    port: 8317
    tls:
      enable: false
      cert: ""
      key: ""
    remote-management:
      allow-remote: false
      secret-key: "${placeholders.cliproxy_management_key}"
      disable-control-panel: false
      panel-github-repository: "https://github.com/router-for-me/Cli-Proxy-API-Management-Center"
    auth-dir: "/var/lib/cliproxyapi/.cli-proxy-api"
    api-keys:
      - "${placeholders.openai_api_key}"
    debug: false
    pprof:
      enable: false
      addr: "127.0.0.1:8316"
    commercial-mode: false
    logging-to-file: true
    logs-max-total-size-mb: 10
    error-logs-max-files: 10
    usage-statistics-enabled: true
    proxy-url: ""
    force-model-prefix: true
    passthrough-headers: false
    request-retry: 3
    max-retry-credentials: 0
    max-retry-interval: 30
    disable-cooling: false
    quota-exceeded:
      switch-project: true
      switch-preview-model: true
      antigravity-credits: true
    routing:
      strategy: "fill-first"
    ws-auth: false
    enable-gemini-cli-endpoint: false
    nonstream-keepalive-interval: 0
  '';
in
lib.mkMerge [
  {
    assertions = [
      {
        assertion = builtins.pathExists secretFile;
        message = "Create phase3-assistant-stack/secrets/minutka.yaml and encrypt it with sops before deployment.";
      }
    ];
  }

  (lib.mkIf (builtins.pathExists secretFile) {
    _module.args.minutkaSecrets = {
      environmentFile = config.sops.templates."minutka.env".path;
      minioRootCredentialsFile = config.sops.templates."minio-root.env".path;
      backupPgpassFile = config.sops.templates."minutka-backup.pgpass".path;
      cliproxyConfigFile = config.sops.templates."cliproxyapi.yaml".path;
      inherit runtimeSecretPaths;
    };

    assertions = [
      {
        assertion = encryptionMarkerCount >= expectedEncryptionMarkerCount;
        message = "secrets/minutka.yaml must be a fully sops-encrypted document; plaintext or partially encrypted bundles are refused.";
      }
      {
        assertion = !(builtins.any containsPlaceholder placeholderMarkers);
        message = "Replace every change-me/REPLACE_ME placeholder in secrets/minutka.yaml and re-encrypt it before deployment.";
      }
    ];

    sops = {
      defaultSopsFile = secretFile;
      defaultSopsFormat = "yaml";
      age.sshKeyPaths = [ "/etc/ssh/ssh_host_ed25519_key" ];

      secrets = lib.mapAttrs'
        (name: _: lib.nameValuePair (secretPath name) {
          owner = "minutka";
          group = if builtins.elem name [ "minutka_db_password" "minutka_migrator_db_password" "minio_access_key" "minio_secret_key" ] then "postgres" else "minutka";
          mode = if builtins.elem name [ "minutka_db_password" "minutka_migrator_db_password" "minio_access_key" "minio_secret_key" ] then "0440" else "0400";
        })
        allSecrets;

      templates = {
        "minutka.env" = {
          owner = "minutka";
          group = "minutka";
          mode = "0400";
          content = lib.concatStringsSep "\n" environmentLines + "\n";
        };

        "minio-root.env" = {
          owner = "minio";
          group = "minio";
          mode = "0400";
          content = lib.concatStringsSep "\n" minioRootCredentialLines + "\n";
        };

        "minutka-backup.pgpass" = {
          owner = "minutka";
          group = "minutka";
          mode = "0400";
          content = backupPgpassLine + "\n";
        };

        "cliproxyapi.yaml" = {
          owner = "cliproxyapi";
          group = "cliproxyapi";
          mode = "0400";
          content = cliproxyConfig;
        };
      };
    };
  })
]
