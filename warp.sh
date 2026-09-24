#!/usr/bin/env bash
# warp.sh — set up a FREE Cloudflare WARP proxy (wireproxy) on 127.0.0.1:40000.
# Used by the arena-bridge to avoid Cloudflare challenges when automating
# arena.ai (the same technique official 1.1.1.1 clients use).
#
#   bash warp.sh [--port 40000] [--bin-dir ~/.warp]
set -euo pipefail

WARP_DIR="${WARP_DIR:-$HOME/.warp}"
SOCKS_PORT="${SOCKS_PORT:-40000}"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> [1/4] wireproxy binary"
mkdir -p "$WARP_DIR"
WP_BIN="$WARP_DIR/wireproxy"
if [[ ! -x "$WP_BIN" ]]; then
  OS_ARCH="linux_amd64"
  URL="https://github.com/pufferffish/wireproxy/releases/download/v1.0.9/wireproxy_${OS_ARCH}.tar.gz"
  echo "    downloading $URL"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$URL" -o "$WARP_DIR/wp.tgz"
  else
    wget -qO "$WARP_DIR/wp.tgz" "$URL"
  fi
  tar xzf "$WARP_DIR/wp.tgz" -C "$WARP_DIR"
  chmod +x "$WP_BIN"
  rm -f "$WARP_DIR/wp.tgz"
fi
echo "    binary: $WP_BIN"

echo "==> [2/4] register WARP account + write config"
if [[ ! -f "$WARP_DIR/wireproxy.conf" ]]; then
  (cd "$SRC_DIR" && node bin/warp-setup.mjs --out "$WARP_DIR/wireproxy.conf" --port "$SOCKS_PORT")
fi

echo "==> [3/4] start wireproxy"
if ! ss -tln 2>/dev/null | grep -q ":$SOCKS_PORT"; then
  (cd "$WARP_DIR" && nohup ./wireproxy -c wireproxy.conf > wireproxy.log 2>&1 &)
  for i in $(seq 1 15); do
    ss -tln 2>/dev/null | grep -q ":$SOCKS_PORT" && break
    sleep 1
  done
fi
if ! ss -tln 2>/dev/null | grep -q ":$SOCKS_PORT"; then
  echo "ERROR: wireproxy did not start. See $WARP_DIR/wireproxy.log" >&2
  tail -20 "$WARP_DIR/wireproxy.log" >&2 || true
  exit 1
fi
echo "    SOCKS5 listening on 127.0.0.1:$SOCKS_PORT"

echo "==> [4/4] verify exit IP"
IP="$(curl -s -m 20 --socks5-hostname 127.0.0.1:$SOCKS_PORT https://api.ipify.org || true)"
echo "    WARP exit IP: ${IP:-unknown}"
if [[ -n "$IP" ]]; then
  echo "==> WARP ready — set ARENA_AGENT_PROXY=socks5://127.0.0.1:$SOCKS_PORT and start the bridge."
else
  echo "WARN: could not reach the internet through WARP yet." >&2
fi
