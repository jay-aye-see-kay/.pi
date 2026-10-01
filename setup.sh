#!/usr/bin/env bash
# Link per-host config: settings.json / mcp.json -> *.<hostname>.json
set -euo pipefail
cd "$(dirname "$0")"
repo_root="$(git -C . rev-parse --show-toplevel)"

# Synced git hooks (.githooks/post-merge reinstalls local extension packages
# after a pull); core.hooksPath is per-machine config, so set it here.
git -C "$repo_root" config core.hooksPath .githooks
echo "set core.hooksPath = .githooks"

host="$(hostname -s)"
agent="$(pwd)/agent"
for name in settings mcp; do
  variant="$agent/${name}.${host}.json"
  [[ -f "$variant" ]] || { echo "skip: no agent/${name}.${host}.json"; continue; }
  ln -sfn "$variant" "$agent/${name}.json"
  echo "linked agent/${name}.json -> ${name}.${host}.json"
done

# Link per-host mcporter config: ~/.mcporter/mcporter.json -> repo mcporter/mcporter.<host>.json
# (secrets like credentials.json stay in ~/.mcporter, out of git)
mcporter_variant="$(pwd)/mcporter/mcporter.${host}.json"
if [[ -f "$mcporter_variant" ]]; then
  mkdir -p "$HOME/.mcporter"
  ln -sfn "$mcporter_variant" "$HOME/.mcporter/mcporter.json"
  echo "linked ~/.mcporter/mcporter.json -> $mcporter_variant"
else
  echo "skip: no mcporter/mcporter.${host}.json"
fi
