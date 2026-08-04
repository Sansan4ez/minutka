#!/usr/bin/env bash
set -euo pipefail

NIXOS_ANYWHERE_FLAKE="${NIXOS_ANYWHERE_FLAKE:-github:nix-community/nixos-anywhere}"
LOG_DIR="${LOG_DIR:-./logs}"
TIMESTAMP="$(date +%F-%H%M%S)"
LOG_FILE="${LOG_DIR}/install-vm-test-${TIMESTAMP}.log"

mkdir -p "$LOG_DIR"

echo "[phase1] vm-test log: $LOG_FILE"

nix --extra-experimental-features 'nix-command flakes' run "$NIXOS_ANYWHERE_FLAKE" -- \
  --debug \
  --print-build-logs \
  --flake .#personal-assistant-1 \
  --vm-test |& tee "$LOG_FILE"
