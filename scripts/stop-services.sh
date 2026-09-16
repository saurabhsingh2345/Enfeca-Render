#!/bin/bash
set -euo pipefail
USER_ID=$(id -u)
for label in com.enfeca.render.cloud com.enfeca.render.worker-3853 com.enfeca.render.worker-3854; do
  launchctl bootout "gui/$USER_ID/$label" 2>/dev/null && echo "stopped $label" || echo "skip $label"
done
