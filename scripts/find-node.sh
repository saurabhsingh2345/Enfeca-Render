#!/bin/bash
# Resolve a Node binary for LaunchAgents and setup scripts.
find_node() {
  if [[ -n "${NODE:-}" && -x "$NODE" ]]; then
    echo "$NODE"
    return 0
  fi
  for candidate in \
    "$(command -v node 2>/dev/null)" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    "$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin/node"
  do
    [[ -n "$candidate" && -x "$candidate" ]] || continue
    echo "$candidate"
    return 0
  done
  return 1
}
