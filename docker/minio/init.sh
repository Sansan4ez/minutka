#!/bin/sh
set -eu

alias_name="vault"
endpoint="http://minio:9000"
policy_file="/tmp/personal-vault-policy.json"

mc alias set "$alias_name" "$endpoint" "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
mc mb --ignore-existing "$alias_name/$MINIO_BUCKET"
mc version enable "$alias_name/$MINIO_BUCKET"

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

# Explicit existence checks make the init job safe on restarts and after a
# volume restore. Credentials and policy changes are managed deliberately,
# rather than silently replacing an already-provisioned application account.
if ! mc admin user info "$alias_name" "$MINIO_ACCESS_KEY" >/dev/null 2>&1; then
  mc admin user add "$alias_name" "$MINIO_ACCESS_KEY" "$MINIO_SECRET_KEY"
fi
if ! mc admin policy info "$alias_name" personal-vault-app >/dev/null 2>&1; then
  mc admin policy create "$alias_name" personal-vault-app "$policy_file"
fi
mc admin policy attach "$alias_name" personal-vault-app --user "$MINIO_ACCESS_KEY"
