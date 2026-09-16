#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=find-node.sh
source "$ROOT/scripts/find-node.sh"

NODE_BIN="$(find_node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "Node.js not found. Run bash setup.sh first."
  exit 1
fi

LA="$HOME/Library/LaunchAgents"
LOG="/tmp/enfeca-render"
mkdir -p "$LOG" "$ROOT/worker-3853/data" "$ROOT/worker-3854/data" "$ROOT/data/out"

write_worker_plist() {
  local label="$1" port="$2"
  cat > "$LA/${label}.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array>
    <string>${NODE_BIN}</string>
    <string>${ROOT}/engine/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}/engine</string>
  <key>EnvironmentVariables</key><dict>
    <key>PORT</key><string>${port}</string>
    <key>AGENT_ISOLATED</key><string>1</string>
    <key>AGENT_DATA_ROOT</key><string>${ROOT}/worker-${port}</string>
  </dict>
  <key>StandardOutPath</key><string>${LOG}/worker-${port}.log</string>
  <key>StandardErrorPath</key><string>${LOG}/worker-${port}.log</string>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
</dict></plist>
EOF
}

cat > "$LA/com.enfeca.render.cloud.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.enfeca.render.cloud</string>
  <key>ProgramArguments</key><array>
    <string>${NODE_BIN}</string>
    <string>${ROOT}/cloud/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}/cloud</string>
  <key>StandardOutPath</key><string>${LOG}/cloud.log</string>
  <key>StandardErrorPath</key><string>${LOG}/cloud.log</string>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
</dict></plist>
EOF

write_worker_plist "com.enfeca.render.worker-3853" 3853
write_worker_plist "com.enfeca.render.worker-3854" 3854

USER_ID=$(id -u)
for label in com.enfeca.render.cloud com.enfeca.render.worker-3853 com.enfeca.render.worker-3854; do
  launchctl bootout "gui/$USER_ID/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$USER_ID" "$LA/${label}.plist"
  echo "loaded $label"
done

echo
echo "Services installed. Open http://127.0.0.1:3849"
echo "Logs: $LOG/cloud.log  $LOG/worker-3853.log  $LOG/worker-3854.log"
