#!/usr/bin/env bash
set -euo pipefail

nix --extra-experimental-features 'nix-command flakes' run github:serokell/deploy-rs -- .#personal-assistant-1 "$@"
