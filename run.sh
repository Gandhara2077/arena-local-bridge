#!/usr/bin/env bash
# run.sh — start the arena-bridge with the default local data dir.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
export DATA_DIR="${DATA_DIR:-$HOME/.arena-bridge}"
mkdir -p "$DATA_DIR"
echo "==> arena-bridge (local) | DATA_DIR=$DATA_DIR"
exec node src/index.mjs
