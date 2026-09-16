#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=find-node.sh
source "$ROOT/scripts/find-node.sh"

echo "Enfeca Render — doctor"
echo "Root: $ROOT"
echo

NODE_BIN="$(find_node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "FAIL  Node.js not found. Install from https://nodejs.org or: brew install node"
  exit 1
fi
echo "OK    Node $("$NODE_BIN" -v) at $NODE_BIN"

for dir in engine cloud; do
  if [[ ! -d "$ROOT/$dir/node_modules" ]]; then
    echo "FAIL  Missing $dir/node_modules — run: bash setup.sh"
    exit 1
  fi
  echo "OK    $dir/node_modules present"
done

if [[ ! -f "$ROOT/engine/node_modules/ffmpeg-static/ffmpeg" ]]; then
  echo "WARN  ffmpeg-static binary missing — re-run setup.sh"
else
  echo "OK    ffmpeg bundled"
fi

if [[ ! -f "$ROOT/.env" ]]; then
  echo "WARN  .env missing — run setup.sh or copy .env.example"
else
  if grep -q '^RENDER_API_KEY=$' "$ROOT/.env" 2>/dev/null || ! grep -q '^RENDER_API_KEY=' "$ROOT/.env"; then
    echo "WARN  RENDER_API_KEY not set — paste in .env or at http://127.0.0.1:3849"
  else
    echo "OK    RENDER_API_KEY set"
  fi
  MACHINE="$(grep '^RENDER_MACHINE=' "$ROOT/.env" | cut -d= -f2- || true)"
  echo "OK    machine: ${MACHINE:-mac-1}"
fi

for port in 3849 3853 3854; do
  if lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "OK    port $port listening"
  else
    echo "      port $port free (start services or npm start)"
  fi
done

echo
echo "Open http://127.0.0.1:3849 after starting."
