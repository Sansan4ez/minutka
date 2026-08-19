#!/usr/bin/env bash
set -euo pipefail

TARGET="$(nix-instantiate --eval --strict --expr '(import ./site.nix).deploy.sshTarget' | tr -d '"')"
IDENTITY="$(nix-instantiate --eval --strict --expr 'let s = import ./site.nix; in if s.deploy ? sshIdentityFile then s.deploy.sshIdentityFile else ""' | tr -d '"')"
NIXOS_ANYWHERE_FLAKE="${NIXOS_ANYWHERE_FLAKE:-github:nix-community/nixos-anywhere}"
BUILD_ON="${BUILD_ON:-remote}"
LOG_DIR="${LOG_DIR:-./logs}"
TIMESTAMP="$(date +%F-%H%M%S)"
LOG_FILE="${LOG_DIR}/install-server-${TIMESTAMP}.log"
HOST_KEY_FILE="${HOST_KEY_FILE:-$HOME/.config/minutka/production/ssh_host_ed25519_key}"

mkdir -p "$LOG_DIR"

if [ ! -s "$HOST_KEY_FILE" ] || [ ! -s "$HOST_KEY_FILE.pub" ]; then
  echo "Missing pinned production SSH host key: $HOST_KEY_FILE and $HOST_KEY_FILE.pub" >&2
  exit 1
fi

EXTRA_FILES="$(mktemp -d)"
cleanup() {
  rm -rf "$EXTRA_FILES"
}
trap cleanup EXIT
install -d -m 0755 "$EXTRA_FILES/etc/ssh"
install -m 0600 "$HOST_KEY_FILE" "$EXTRA_FILES/etc/ssh/ssh_host_ed25519_key"
install -m 0644 "$HOST_KEY_FILE.pub" "$EXTRA_FILES/etc/ssh/ssh_host_ed25519_key.pub"

ARGS=(
  --debug
  --print-build-logs
  --build-on "$BUILD_ON"
  --generate-hardware-config nixos-generate-config ./hosts/minutka-1/hardware-configuration.nix
  --extra-files "$EXTRA_FILES"
  --flake .#minutka-1
  --target-host "$TARGET"
)

if [ -n "$IDENTITY" ]; then
  ARGS+=( -i "$IDENTITY" --ssh-option IdentitiesOnly=yes )
fi

if [ "${NO_DISKO_DEPS:-0}" = "1" ]; then
  ARGS+=( --no-disko-deps )
fi

echo "[phase1] install log: $LOG_FILE"
echo "[phase1] build mode: $BUILD_ON"

nix --extra-experimental-features 'nix-command flakes' run "$NIXOS_ANYWHERE_FLAKE" -- "${ARGS[@]}" |& tee "$LOG_FILE"
