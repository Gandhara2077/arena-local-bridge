#!/usr/bin/env bash
# bootstrap.sh — download and install Arena Local Bridge without git.
set -euo pipefail

REPO="${REPO:-Gandhara2077/arena-local-bridge}"
BRANCH="${BRANCH:-main}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> Downloading $REPO ($BRANCH)..."
if command -v curl >/dev/null 2>&1; then
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" -o "$TMP/project.tgz"
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$TMP/project.tgz" "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH"
else
  echo "ERROR: need curl or wget" >&2
  exit 1
fi

mkdir -p "$TMP/x"
tar xzf "$TMP/project.tgz" -C "$TMP/x"
PROJECT_DIR="$(find "$TMP/x" -maxdepth 1 -type d -name 'arena-local-bridge-*' | head -1)"
if [[ -z "$PROJECT_DIR" ]]; then
  echo "ERROR: extraction failed" >&2
  exit 1
fi

echo "==> Running install.sh"
cd "$PROJECT_DIR"
bash install.sh "$@"
