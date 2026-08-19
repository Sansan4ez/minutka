#!/usr/bin/env bash
set -euo pipefail

DEPLOY_ARGS=( .#minutka-1 )

if [ -n "${LOG_DIR:-}" ]; then
  mkdir -p "$LOG_DIR"
  DEPLOY_ARGS+=( --log-dir "$LOG_DIR" )
fi

nix --extra-experimental-features 'nix-command flakes' run github:serokell/deploy-rs -- "${DEPLOY_ARGS[@]}" "$@"
