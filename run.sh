#!/usr/bin/env bash
# run.sh — start the arena-bridge with the default local data dir.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
: "${DATA_DIR:=$HOME/.arena-bridge}"
export DATA_DIR
mkdir -p "$DATA_DIR"
printf '==> arena-bridge (local) | DATA_DIR=%s\n' "$DATA_DIR"
exec node src/index.mjs
