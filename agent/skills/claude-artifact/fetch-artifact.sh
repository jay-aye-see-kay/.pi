#!/usr/bin/env bash
# Fetch a claude.ai artifact's HTML and convert it to Markdown.
# Usage: fetch-artifact.sh <url-or-id> [out_dir]   (default out_dir: /tmp/claude-artifact/<id>)
# Prints the paths of index.html, page.md and the claude log. Exits non-zero on failure.
#
# Only Claude Code's Artifact tool can read artifacts (they sit behind claude.ai login), so a
# cheap model makes one call that saves the raw HTML to out_dir; the page never enters its
# context. pandoc then converts it locally.
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $(basename "$0") <artifact-url-or-id> [out_dir]" >&2
  exit 2
fi

ref="$1"
# Bare IDs: UUIDs are Claude Code artifacts, short IDs are claude.ai artifacts.
if [[ "$ref" =~ ^https?:// ]]; then
  url="$ref"
elif [[ "$ref" =~ ^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$ ]]; then
  url="https://claude.ai/code/artifact/$ref"
elif [[ "$ref" =~ ^[A-Za-z0-9]{10,40}$ ]]; then
  url="https://claude.ai/artifact/$ref"
else
  echo "error: not an artifact URL or ID: $ref" >&2
  exit 2
fi
id="${url%%[?#]*}"; id="${id%/}"; id="${id##*/}"

if [[ -z "${PI_CLAUDE_OAUTH_TOKEN:-}" ]]; then
  cat >&2 <<'EOF'
error: PI_CLAUDE_OAUTH_TOKEN is not set. One-time setup (outside the sandbox):
  claude setup-token
  security add-generic-password -U -a "$USER" -s pi-claude-oauth-token -w
then restart pi so agent/extensions/secrets.ts injects it.
EOF
  exit 3
fi

base=/tmp/claude-artifact
mkdir -p "${2:-$base/$id}"
out="$(cd "${2:-$base/$id}" && pwd -P)" # resolved, so the Edit rule matches (/tmp -> /private/tmp)
rm -f "$out/index.html" "$out/page.md"
log="$out/claude.jsonl"

# CLAUDE_CODE_ARTIFACT=1: load the Artifact tool in print mode (off by default there).
# Edit(...) rule: let the Artifact tool write into $out only (needed even for shared artifacts).
# CLAUDE_CONFIG_DIR: the sandbox can't write ~/.claude; reused because a fresh one costs ~100MB.
# PI_CLAUDE_OAUTH_TOKEN: the sandbox can't read claude's keychain login.
(cd "$out" && CLAUDE_CONFIG_DIR="$base/.config" CLAUDE_CODE_OAUTH_TOKEN="$PI_CLAUDE_OAUTH_TOKEN" \
  CLAUDE_CODE_ARTIFACT=1 claude -p \
  "Call the Artifact tool once with {\"action\":\"read\",\"url\":\"$url\",\"path\":\"index.html\",\"out_dir\":\"$out\"}. Reply with only the tool's result text." \
  --model haiku --tools Artifact --allowedTools "Edit(/$out/**)" \
  --output-format stream-json --verbose </dev/null >"$log" 2>&1) || true

if [[ ! -s "$out/index.html" ]]; then
  echo "error: could not read $url:" >&2
  jq -r 'select(.type=="result") | .result' "$log" >&2 2>/dev/null || tail -n 5 "$log" >&2
  echo "full log: $log" >&2
  exit 1
fi

echo "html: $out/index.html"
pandoc -f html -t gfm-raw_html --wrap=none "$out/index.html" -o "$out/page.md"
echo "md:   $out/page.md"
echo "log:  $log"
