#!/usr/bin/env bash
# Link per-host config: settings.json / mcp.json -> *.<hostname>.json
set -euo pipefail
cd "$(dirname "$0")"

host="$(hostname -s)"
for name in settings mcp; do
  variant="${name}.${host}.json"
  [[ -f "$variant" ]] || { echo "skip: no $variant"; continue; }
  ln -sfn "$variant" "${name}.json"
  echo "linked ${name}.json -> $variant"
done
