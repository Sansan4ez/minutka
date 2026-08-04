#!/usr/bin/env bash
set -euo pipefail

TARGET="$(nix-instantiate --eval --strict --expr '(import ./site.nix).deploy.sshTarget' | tr -d '"')"
IDENTITY="$(nix-instantiate --eval --strict --expr 'let s = import ./site.nix; in if s.deploy ? sshIdentityFile then s.deploy.sshIdentityFile else ""' | tr -d '"')"
NIXOS_ANYWHERE_FLAKE="${NIXOS_ANYWHERE_FLAKE:-github:nix-community/nixos-anywhere}"
BUILD_ON="${BUILD_ON:-remote}"
LOG_DIR="${LOG_DIR:-./logs}"
TIMESTAMP="$(date +%F-%H%M%S)"
LOG_FILE="${LOG_DIR}/install-server-${TIMESTAMP}.log"

mkdir -p "$LOG_DIR"

ARGS=(
  --debug
  --print-build-logs
  --build-on "$BUILD_ON"
  --generate-hardware-config nixos-generate-config ./hosts/personal-assistant-1/hardware-configuration.nix
  --flake .#personal-assistant-1
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
