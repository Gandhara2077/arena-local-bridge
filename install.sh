#!/usr/bin/env bash
# install.sh — one-shot installer for the arena-bridge skill (v2, hardened).
#   bash install.sh [--email e] [--password p] [--key hex] [--port N]
#                   [--proxy socks5://...] [--data-dir DIR] [--no-login] [--chrome /path]
#   email/password can also come from ARENA_EMAIL / ARENA_PASSWORD (env).
set -uo pipefail

EMAIL="${ARENA_EMAIL:-}"
PASSWORD="${ARENA_PASSWORD:-}"
KEY=""
PORT="20140"
PROXY=""
DATA_DIR="${DATA_DIR:-$HOME/.arena-bridge}"
NO_LOGIN=0
CHROME=""
WARP=0
SOCKS_PORT="${SOCKS_PORT:-40000}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --email) EMAIL="$2"; shift 2 ;;
    --password) PASSWORD="$2"; shift 2 ;;
    --key) KEY="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --proxy) PROXY="$2"; shift 2 ;;
    --data-dir) DATA_DIR="$2"; shift 2 ;;
    --chrome) CHROME="$2"; shift 2 ;;
    --no-login) NO_LOGIN=1; shift ;;
    --warp) WARP=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "==> [1/7] Node.js check"
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: node not found. Install Node.js >= 18 first." >&2; exit 1
fi
NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
echo "    node $(node -v) (major $NODE_MAJOR)"
if (( NODE_MAJOR < 20 )); then echo "ERROR: need node >= 20" >&2; exit 1; fi

echo "==> [2/7] Install playwright (with retries) + chromium"
if (( WARP )); then
  echo "    --warp: starting Cloudflare WARP proxy first (avoids CF challenges)"
  if ! bash "$SRC_DIR/warp.sh" --port "$SOCKS_PORT"; then
    echo "WARN: WARP setup failed; continuing without proxy (may hit Cloudflare)" >&2
  else
    PROXY="socks5://127.0.0.1:$SOCKS_PORT"
    echo "    using proxy: $PROXY"
  fi
fi
if [[ ! -d "$SRC_DIR/node_modules/playwright" ]]; then
  for i in 1 2 3; do
    (cd "$SRC_DIR" && npm install playwright --no-audit --no-fund) && break
    echo "    npm install failed (attempt $i); retrying in 3s"; sleep 3
  done
fi
for i in 1 2 3; do
  (cd "$SRC_DIR" && npx playwright install chromium 2>&1 | tail -1) && break
  echo "    playwright chromium install failed (attempt $i); retrying in 3s"; sleep 3
done
if command -v sudo >/dev/null 2>&1; then
  (cd "$SRC_DIR" && sudo npx playwright install-deps chromium >/dev/null 2>&1 || true) || true
fi

# Locate a working chromium binary (playwright default OR system chrome)
if [[ -z "$CHROME" ]]; then
  CHROME="$(cd "$SRC_DIR" && node -e "
    try { const { chromium } = require('playwright'); process.stdout.write(chromium.executablePath()); }
    catch(e){ process.stdout.write(''); }
  " 2>/dev/null || true)"
fi
if [[ -z "$CHROME" || ! -f "$CHROME" ]]; then
  for cand in chromium chromium-browser google-chrome google-chrome-stable chrome-headless-shell; do
    P="$(command -v "$cand" 2>/dev/null || true)"
    if [[ -n "$P" ]]; then CHROME="$P"; break; fi
  done
fi
if [[ -n "$CHROME" && -f "$CHROME" ]]; then
  echo "    chromium: $CHROME"
else
  echo "WARN: could not locate a chromium binary automatically; set --chrome /path/to/chrome" >&2
fi

echo "==> [3/7] Prepare data dir + env ($DATA_DIR)"
mkdir -p "$DATA_DIR"; chmod 700 "$DATA_DIR" 2>/dev/null || true
ENV_FILE="$DATA_DIR/.env"; touch "$ENV_FILE"; chmod 600 "$ENV_FILE" 2>/dev/null || true

if [[ -z "$KEY" ]]; then
  KEY="$(openssl rand -hex 24 2>/dev/null || head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n')"
fi
if ! grep -q '^STORAGE_ENCRYPTION_KEY=' "$ENV_FILE" 2>/dev/null; then
  echo "STORAGE_ENCRYPTION_KEY=$(openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n')" >> "$ENV_FILE"
fi
sed -i "/^PORT=/d;/^ARENA_AGENT_PROXY=/d;/^ARENA_AGENT_BRIDGE_KEY=/d;/^ARENA_AGENT_CHROME=/d" "$ENV_FILE" 2>/dev/null || true
echo "PORT=$PORT" >> "$ENV_FILE"
[[ -n "$PROXY" ]] && echo "ARENA_AGENT_PROXY=$PROXY" >> "$ENV_FILE"
[[ -n "$CHROME" ]] && echo "ARENA_AGENT_CHROME=$CHROME" >> "$ENV_FILE"
echo "ARENA_AGENT_BRIDGE_KEY=$KEY" >> "$ENV_FILE"
echo "DATA_DIR=$DATA_DIR" >> "$ENV_FILE"

echo "==> [4/7] Login to arena.ai (your own account)"
if (( NO_LOGIN )); then
  echo "    --no-login: skipping login. Run later: node bin/login.mjs --email <e> --password <p>"
elif [[ -z "$EMAIL" ]]; then
  echo "ERROR: no email. Pass --email you@example.com or set ARENA_EMAIL." >&2
  echo "       (bridge key: $KEY)" >&2
  exit 1
else
  if [[ -z "$PASSWORD" ]]; then
    read -rsp "Password for $EMAIL: " PASSWORD; echo
  fi
  (cd "$SRC_DIR" && DATA_DIR="$DATA_DIR" ARENA_AGENT_BRIDGE_KEY="$KEY" \
    node bin/login.mjs --email "$EMAIL" --password "$PASSWORD")
fi

echo "==> [5/7] Start bridge"
if (( NO_LOGIN )); then
  echo "    --no-login: bridge NOT started (no credentials yet)."
  echo "    Later, run:"
  echo "      node bin/login.mjs --email <e> --password <p>"
  echo "      bash run.sh   (or: node src/index.mjs)"
  echo
  echo "==============================================================="
  echo " arena-bridge v2 installed (infra only, no login)."
  echo " Bridge key : $KEY   (also stored in $ENV_FILE)"
  echo " Run login + start when you have your credentials."
  echo "==============================================================="
  exit 0
fi
pkill -f "$SRC_DIR/src/index.mjs" 2>/dev/null || true
sleep 1
(cd "$SRC_DIR" && DATA_DIR="$DATA_DIR" ARENA_AGENT_BRIDGE_KEY="$KEY" \
  nohup node src/index.mjs > "$DATA_DIR/bridge.log" 2>&1 &)

echo "==> [6/7] Wait for health"
HEALTHY=0
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/health" >/tmp/arena-bridge-health.json 2>/dev/null; then
    HEALTHY=1; break
  fi
  sleep 2
done
if (( ! HEALTHY )); then
  echo "ERROR: bridge did not become healthy within 60s — see $DATA_DIR/bridge.log" >&2
  tail -30 "$DATA_DIR/bridge.log" >&2 || true
  exit 1
fi

echo "==> [7/7] Self-test"
SELFTEST_OK=1
(cd "$SRC_DIR" && DATA_DIR="$DATA_DIR" ARENA_AGENT_BRIDGE_KEY="$KEY" \
  node bin/selftest.mjs) || SELFTEST_OK=0

echo
echo "==============================================================="
echo " arena-bridge v2 is UP on http://127.0.0.1:$PORT"
echo " Bridge key : $KEY   (also stored in $ENV_FILE)"
echo " Self-test  : $([ $SELFTEST_OK -eq 1 ] && echo PASS ✅ || echo 'FAIL (see above)')"
echo "---------------------------------------------------------------"
echo " Chat:"
echo "   curl -X POST http://127.0.0.1:$PORT/v1/chat/completions \\"
echo "     -H \"Authorization: Bearer $KEY\" -H 'Content-Type: application/json' \\"
echo "     -d '{\"model\":\"agent\",\"messages\":[{\"role\":\"user\",\"content\":\"Salam\"}]}'"
echo " Team leader (one session per agent):"
echo "   ... add -H 'x-codex-session-id: agent-<name>'"
echo "==============================================================="
