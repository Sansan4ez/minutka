#!/usr/bin/env bash
set -euo pipefail

TARGET="$(nix-instantiate --eval --strict --expr '(import ./site.nix).deploy.sshTarget' | tr -d '"')"
SSH_USER="$(nix-instantiate --eval --strict --expr '(import ./site.nix).deploy.sshUser' | tr -d '"')"
IDENTITY="$(nix-instantiate --eval --strict --expr 'let s = import ./site.nix; in if s.deploy ? sshIdentityFile then s.deploy.sshIdentityFile else ""' | tr -d '"')"

SSH_ARGS=()
if [ -n "$IDENTITY" ]; then
  SSH_ARGS+=( -i "$IDENTITY" -o IdentitiesOnly=yes )
fi

REMOTE_CMD='nixos-rebuild switch --rollback'
if [ "$SSH_USER" != "root" ]; then
  REMOTE_CMD="sudo ${REMOTE_CMD}"
fi

ssh "${SSH_ARGS[@]}" "$TARGET" "$REMOTE_CMD"
