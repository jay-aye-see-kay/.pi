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

# Link per-host mcporter config: ~/.mcporter/mcporter.json -> repo mcporter/mcporter.<host>.json
# (secrets like credentials.json stay in ~/.mcporter, out of git)
mcporter_variant="$(pwd)/../mcporter/mcporter.${host}.json"
if [[ -f "$mcporter_variant" ]]; then
  mkdir -p "$HOME/.mcporter"
  ln -sfn "$mcporter_variant" "$HOME/.mcporter/mcporter.json"
  echo "linked ~/.mcporter/mcporter.json -> $mcporter_variant"
else
  echo "skip: no mcporter/mcporter.${host}.json"
fi
