#!/usr/bin/env bash
set -Eeuo pipefail

readonly source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly backup_user="minutka-offsite-backup"
readonly backup_group="$backup_user"
readonly backup_root="/srv/backups/minutka"
readonly config_dir="/etc/minutka-offsite-backup"
readonly private_key_source="${MINUTKA_PULL_KEY_FILE:-/home/admin/.ssh/id_minutka_pull}"
readonly known_hosts_source="${MINUTKA_KNOWN_HOSTS_FILE:-/home/admin/.ssh/known_hosts}"
readonly source_host="169.58.201.159"
readonly expected_key_fingerprint="SHA256:FlHH2mruMIv7zMxXexwUlgbzfEADdc3nSRvEp1KAM9k"
readonly expected_host_fingerprint="SHA256:+IYaUr7nIW5m0dozT5jXMbJQ+O8upC+PcIMVXLita3A"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer as root." >&2
  exit 1
fi

for source_file in \
  "$source_dir/pull-minutka-backups" \
  "$source_dir/pull-minutka-backups.service" \
  "$source_dir/pull-minutka-backups.timer" \
  "$private_key_source" \
  "$known_hosts_source"; do
  if [ ! -f "$source_file" ]; then
    echo "Required file is missing: $source_file" >&2
    exit 1
  fi
done

actual_key_fingerprint="$(ssh-keygen -y -f "$private_key_source" | ssh-keygen -lf - | awk '{print $2}')"
if [ "$actual_key_fingerprint" != "$expected_key_fingerprint" ]; then
  echo "Unexpected Minutka pull key fingerprint: $actual_key_fingerprint" >&2
  exit 1
fi

host_key="$(ssh-keygen -F "$source_host" -f "$known_hosts_source" | awk '$2 == "ssh-ed25519" { print $2 " " $3; exit }')"
if [ -z "$host_key" ]; then
  echo "No pinned ssh-ed25519 host key for $source_host in $known_hosts_source" >&2
  exit 1
fi
actual_host_fingerprint="$(printf '%s\n' "$host_key" | ssh-keygen -lf - | awk '{print $2}')"
if [ "$actual_host_fingerprint" != "$expected_host_fingerprint" ]; then
  echo "Unexpected production host key fingerprint: $actual_host_fingerprint" >&2
  exit 1
fi

if ! getent group "$backup_group" >/dev/null; then
  groupadd --system "$backup_group"
fi
if ! id "$backup_user" >/dev/null 2>&1; then
  useradd \
    --system \
    --gid "$backup_group" \
    --home-dir /nonexistent \
    --no-create-home \
    --shell /usr/sbin/nologin \
    "$backup_user"
fi

install -d -m 0750 -o "$backup_user" -g "$backup_group" \
  "$backup_root" "$backup_root/snapshots" "$backup_root/logs"
install -d -m 0750 -o root -g "$backup_group" "$config_dir"
install -d -m 0755 -o root -g root /usr/local/libexec
install -d -m 0755 -o root -g root /etc/systemd/system

install -m 0755 -o root -g root \
  "$source_dir/pull-minutka-backups" \
  /usr/local/libexec/pull-minutka-backups
install -m 0400 -o "$backup_user" -g "$backup_group" \
  "$private_key_source" \
  "$config_dir/id_ed25519"
known_hosts_tmp="$(mktemp)"
trap 'rm -f -- "$known_hosts_tmp"' EXIT
printf '%s %s\n' "$source_host" "$host_key" > "$known_hosts_tmp"
install -m 0444 -o root -g root "$known_hosts_tmp" "$config_dir/known_hosts"
install -m 0644 -o root -g root \
  "$source_dir/pull-minutka-backups.service" \
  /etc/systemd/system/pull-minutka-backups.service
install -m 0644 -o root -g root \
  "$source_dir/pull-minutka-backups.timer" \
  /etc/systemd/system/pull-minutka-backups.timer

systemd-tmpfiles --create - <<EOF
D /run/minutka-offsite-backup 0750 $backup_user $backup_group -
EOF

systemctl daemon-reload
systemd-analyze verify \
  /etc/systemd/system/pull-minutka-backups.service \
  /etc/systemd/system/pull-minutka-backups.timer
systemctl enable --now pull-minutka-backups.timer

printf 'Installed Minutka off-site backup pull. Start the first pull with:\n'
printf '  sudo systemctl start pull-minutka-backups.service\n'
