#!/usr/bin/env bash
# Render build step for Oddsmith.
#
# Installs deps, then the two OKX binaries the desk shells out to at runtime:
#   - onchainos CLI (wallet + signing for the buy/positions path)
#   - polymarket-plugin (market resolution + order placement)
#
# The read paths (resolve, the free demo) need only polymarket-plugin. Live
# execution also needs onchainos logged into a funded Polygon (137) wallet, done
# once out of band (see README "Live execution setup").
set -euo pipefail

echo "==> npm install"
npm install

BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
export PATH="$BIN_DIR:$PATH"

echo "==> install onchainos CLI"
if ! command -v onchainos >/dev/null 2>&1; then
  curl -fsSL https://raw.githubusercontent.com/okx/onchainos-skills/main/install.sh | sh || \
    echo "WARN: onchainos install failed; the buy/positions path needs it. Read-only demo still works."
fi

echo "==> install polymarket-plugin binary (Linux x86_64 musl)"
PM_TAG="plugins/polymarket-plugin@0.7.0"
PM_TARGET="x86_64-unknown-linux-musl"
if ! command -v polymarket-plugin >/dev/null 2>&1; then
  TMP="$(mktemp -d)"
  if curl -fsSL "https://github.com/okx/plugin-store/releases/download/${PM_TAG}/polymarket-plugin-${PM_TARGET}" -o "$TMP/polymarket-plugin"; then
    chmod +x "$TMP/polymarket-plugin"
    mv "$TMP/polymarket-plugin" "$BIN_DIR/polymarket-plugin"
    echo "    installed to $BIN_DIR/polymarket-plugin"
  else
    echo "WARN: polymarket-plugin download failed; pin PM_TAG to a current release."
  fi
  rm -rf "$TMP"
fi

echo "==> build (typecheck)"
npm run build

echo "==> done"
