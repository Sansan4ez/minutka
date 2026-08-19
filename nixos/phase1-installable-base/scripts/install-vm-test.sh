#!/usr/bin/env bash
set -euo pipefail

NIXOS_ANYWHERE_FLAKE="${NIXOS_ANYWHERE_FLAKE:-github:nix-community/nixos-anywhere}"
LOG_DIR="${LOG_DIR:-./logs}"
TIMESTAMP="$(date +%F-%H%M%S)"
LOG_FILE="${LOG_DIR}/install-vm-test-${TIMESTAMP}.log"

mkdir -p "$LOG_DIR"

echo "[phase1] vm-test log: $LOG_FILE"

# NixOS tests require the kvm system feature even though QEMU can fall back to
# software emulation when /dev/kvm is unavailable (for example in containers).
if [[ ! -e /dev/kvm ]]; then
  export NIX_CONFIG="${NIX_CONFIG:+${NIX_CONFIG}
}extra-system-features = kvm"
  echo "[phase1] /dev/kvm is unavailable; using QEMU software emulation"
fi

nix --extra-experimental-features 'nix-command flakes' run "$NIXOS_ANYWHERE_FLAKE" -- \
  --debug \
  --print-build-logs \
  --flake .#minutka-1 \
  --vm-test |& tee "$LOG_FILE"
