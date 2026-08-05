{ lib, pkgs, site, personalAssistantSecrets, ... }:

let
  bucket = "personal-assistant";
  policyName = "personal-vault-app";
  endpoint = "http://127.0.0.1:9000";
  dataDir = site.storage.minio.dataDir;
  capacityBytes = site.storage.minio.capacityBytes;
  filesystemReserveBytes = site.storage.minio.filesystemReserveBytes;
  artifactBudgetBytes = 48318382080;
  applicationReserveBytes = 5368709120;
  secretPaths = personalAssistantSecrets.runtimeSecretPaths;

  provisionMinio = pkgs.writeShellApplication {
    name = "personal-assistant-minio-provision";
    runtimeInputs = [ pkgs.minio-client pkgs.coreutils ];
    text = ''
      set -euo pipefail

      root_user="$(< "$MINIO_ROOT_USER_FILE")"
      root_password="$(< "$MINIO_ROOT_PASSWORD_FILE")"
      app_user="$(< "$MINIO_ACCESS_KEY_FILE")"
      app_password="$(< "$MINIO_SECRET_KEY_FILE")"
      policy_file="$(mktemp)"

      cleanup() {
        rm -f "$policy_file"
        root_user=
        root_password=
        app_user=
        app_password=
      }
      trap cleanup EXIT

      until mc alias set production "$MINIO_ENDPOINT" "$root_user" "$root_password" >/dev/null 2>&1; do
        sleep 1
      done

      mc mb --ignore-existing "production/$MINIO_BUCKET"
      mc version enable "production/$MINIO_BUCKET"

      cat > "$policy_file" <<EOF
      {
        "Version": "2012-10-17",
        "Statement": [
          {
            "Effect": "Allow",
            "Action": ["s3:GetBucketLocation", "s3:GetBucketVersioning", "s3:ListBucket"],
            "Resource": ["arn:aws:s3:::$MINIO_BUCKET"]
          },
          {
            "Effect": "Allow",
            "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
            "Resource": ["arn:aws:s3:::$MINIO_BUCKET/*"]
          }
        ]
      }
      EOF

      if mc admin user info production "$app_user" >/dev/null 2>&1; then
        mc admin user enable production "$app_user"
      else
        mc admin user add production "$app_user" "$app_password"
      fi

      if ! mc admin policy info production "$MINIO_POLICY" >/dev/null 2>&1; then
        mc admin policy create production "$MINIO_POLICY" "$policy_file"
      fi
      mc admin policy attach production "$MINIO_POLICY" --user "$app_user"
    '';
  };
in
{
  assertions = [
    {
      assertion = personalAssistantSecrets ? minioRootCredentialsFile && personalAssistantSecrets ? runtimeSecretPaths;
      message = "assistant-secrets.nix must provide MinIO root credentials and bootstrap secret paths.";
    }
    {
      assertion = secretPaths ? minio_root_user && secretPaths ? minio_root_password
        && secretPaths ? minio_access_key && secretPaths ? minio_secret_key;
      message = "MinIO provisioning requires root and application credential secret paths.";
    }
    {
      assertion = lib.hasPrefix "/" dataDir && dataDir != "/var/lib/minio/data";
      message = "site.storage.minio.dataDir must be an explicit absolute durable path, not the small default root path.";
    }
    {
      assertion = capacityBytes >= artifactBudgetBytes + applicationReserveBytes + filesystemReserveBytes;
      message = "MinIO capacity must cover the 45 GiB artifact budget, 5 GiB application reserve, and filesystem reserve.";
    }
    {
      assertion = filesystemReserveBytes >= 5368709120;
      message = "MinIO filesystem reserve must be at least 5 GiB for the pilot.";
    }
  ];

  services.minio = {
    enable = true;
    listenAddress = "127.0.0.1:9000";
    consoleAddress = "127.0.0.1:9001";
    dataDir = [ dataDir ];
    rootCredentialsFile = personalAssistantSecrets.minioRootCredentialsFile;
  };

  systemd.tmpfiles.rules = [
    "d ${dataDir} 0700 minio minio -"
  ];

  systemd.services.minio.unitConfig.RequiresMountsFor = dataDir;

  systemd.services.personal-assistant-minio-provision = {
    description = "Provision personal-assistant MinIO bucket and application policy";
    after = [ "minio.service" ];
    requires = [ "minio.service" ];
    before = [ "personal-assistant.service" ];
    wantedBy = [ "personal-assistant.service" ];

    environment = {
      MINIO_ENDPOINT = endpoint;
      MINIO_BUCKET = bucket;
      MINIO_POLICY = policyName;
      MINIO_ROOT_USER_FILE = secretPaths.minio_root_user;
      MINIO_ROOT_PASSWORD_FILE = secretPaths.minio_root_password;
      MINIO_ACCESS_KEY_FILE = secretPaths.minio_access_key;
      MINIO_SECRET_KEY_FILE = secretPaths.minio_secret_key;
    };

    serviceConfig = {
      Type = "oneshot";
      User = "personal-assistant";
      Group = "personal-assistant";
      ExecStart = lib.getExe provisionMinio;
      NoNewPrivileges = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      PrivateTmp = true;
      PrivateDevices = true;
      RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" ];
    };
  };
}
