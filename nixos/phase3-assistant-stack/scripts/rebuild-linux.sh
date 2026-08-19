#!/usr/bin/env bash
set -euo pipefail

TARGET="$(nix-instantiate --eval --strict --expr '(import ./site.nix).deploy.sshTarget' | tr -d '"')"
SSH_USER="$(nix-instantiate --eval --strict --expr '(import ./site.nix).deploy.sshUser' | tr -d '"')"
IDENTITY="$(nix-instantiate --eval --strict --expr 'let s = import ./site.nix; in if s.deploy ? sshIdentityFile then s.deploy.sshIdentityFile else ""' | tr -d '"')"

if [ -n "$IDENTITY" ]; then
  export NIX_SSHOPTS="-i $IDENTITY -o IdentitiesOnly=yes"
fi

REBUILD_ARGS=()
if [ "$SSH_USER" != "root" ]; then
  REBUILD_ARGS+=( --sudo )
fi

nix --extra-experimental-features 'nix-command flakes' run nixpkgs#nixos-rebuild -- dry-activate --flake .#minutka-1 "${REBUILD_ARGS[@]}" --target-host "$TARGET"
nix --extra-experimental-features 'nix-command flakes' run nixpkgs#nixos-rebuild -- test --flake .#minutka-1 "${REBUILD_ARGS[@]}" --target-host "$TARGET"
nix --extra-experimental-features 'nix-command flakes' run nixpkgs#nixos-rebuild -- switch --flake .#minutka-1 "${REBUILD_ARGS[@]}" --target-host "$TARGET"
