#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=scripts/find-node.sh
source "$ROOT/scripts/find-node.sh"

echo "=== Enfeca Render setup ==="
echo "Folder: $ROOT"
echo

NODE_BIN="$(find_node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js is required. Install it first:"
  echo "  brew install node"
  echo "  — or download from https://nodejs.org"
  exit 1
fi
echo "Using Node $("$NODE_BIN" -v) at $NODE_BIN"

mkdir -p \
  "$ROOT/data/out" \
  "$ROOT/data/completed" \
  "$ROOT/worker-3853/data" \
  "$ROOT/worker-3854/data" \
  "/tmp/enfeca-render"

if [[ ! -f "$ROOT/.env" ]]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  HOST="$(scutil --get ComputerName 2>/dev/null | tr ' ' '-' | tr '[:upper:]' '[:lower:]' || hostname -s)"
  sed -i '' "s/^RENDER_MACHINE=.*/RENDER_MACHINE=mac-${HOST}/" "$ROOT/.env" 2>/dev/null \
    || sed -i "s/^RENDER_MACHINE=.*/RENDER_MACHINE=mac-${HOST}/" "$ROOT/.env"
  echo "Created .env — set RENDER_API_KEY before rendering."
else
  echo ".env already exists — keeping your settings."
fi

export PATH="$(dirname "$NODE_BIN"):$PATH"
echo
echo "Installing encode engine dependencies…"
(cd "$ROOT/engine" && npm install --omit=dev)

echo
echo "Cloud queue has no npm dependencies (Node stdlib only)."
mkdir -p "$ROOT/cloud/node_modules"

echo
bash "$ROOT/scripts/doctor.sh"

echo
echo "=== Setup complete ==="
echo
echo "Next steps on this Mac:"
echo "  1. Edit $ROOT/.env — paste RENDER_API_KEY from Lovable Secrets"
echo "  2. Install background services (recommended):"
echo "       bash scripts/install-services.sh"
echo "     Or run once in a terminal:"
echo "       npm start"
echo "  3. Open http://127.0.0.1:3849 — verify key + unique machine name (auto-claim starts HD)"
echo
echo "Copy this entire 'Enfeca Render' folder to another Mac and run setup.sh again."
