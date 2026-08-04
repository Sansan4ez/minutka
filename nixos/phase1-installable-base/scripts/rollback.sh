#!/usr/bin/env bash
set -euo pipefail

TARGET="$(nix-instantiate --eval --strict --expr '(import ./site.nix).deploy.sshTarget' | tr -d '"')"
IDENTITY="$(nix-instantiate --eval --strict --expr 'let s = import ./site.nix; in if s.deploy ? sshIdentityFile then s.deploy.sshIdentityFile else ""' | tr -d '"')"

SSH_ARGS=()
if [ -n "$IDENTITY" ]; then
  SSH_ARGS+=( -i "$IDENTITY" -o IdentitiesOnly=yes )
fi

ssh "${SSH_ARGS[@]}" "$TARGET" 'nixos-rebuild switch --rollback'
