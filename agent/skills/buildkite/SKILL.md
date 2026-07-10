---
name: buildkite
description: Inspect Culture Amp Buildkite pipelines from the CLI via the `bk` tool — list recent/failed builds, read job logs to find why a build failed, and list/download build artifacts. Use for "why did this build fail", "find failed runs", "get the logs for build X", or "download the artifacts".
---

## Auth

`bk` is authenticated read-only via `BUILDKITE_API_TOKEN`, injected from the
keychain by `agent/extensions/secrets.ts`. No `bk auth login` needed — the
sandbox can't reach bk's own keyring, so the env var is the auth path. If you
see "you are not authenticated", the token env var is missing.

## Golden rules

- Always pass `-p <pipeline>` (we're not inside the repo, so bk can't infer it).
  Pipelines this team owns:
  - `agent-workflows` — https://buildkite.com/culture-amp/agent-workflows
  - `frontend-ops` — https://buildkite.com/culture-amp/frontend-ops
  - `critical-user-journey-tests` — https://buildkite.com/culture-amp/critical-user-journey-tests
- Always `--json | jq` to keep output small. Raw output (esp. artifact lists) is huge.
- **Don't** use `bk api <path>` for these — it force-prefixes
  `/v2/organizations/{org}/`, so e.g. `/user` 404s. Use the subcommands below.

## Quick reference

```bash
# Recent runs
bk build list -p frontend-ops --limit 8 --json | \
  jq -r '.[] | "#\(.number) \(.state) \(.branch) \(.created_at)"'

# Failed builds in a window (server-side --state/--since), narrow to a day client-side
bk build list -p critical-user-journey-tests --state failed --since 48h --no-limit --json | \
  jq -r '.[] | select(.created_at|startswith("2026-07-09")) | "#\(.number) \(.web_url)"'

# Jobs in a build (get job UUIDs — logs are per-job, not per-build)
bk build view 4609 -p frontend-ops --json | \
  jq -r '.jobs[] | "\(.id)\t\(.state)\t\(.name)"'

# Logs for one job — prefer --agent for triage (strips ANSI, dedupes loops, LLM-friendly)
bk job log <job-uuid> --agent
bk job log <job-uuid> --agent --format markdown --max-tokens 2000 --no-window
bk job log <job-uuid> --no-timestamps          # raw, when you want the full unprocessed log

# Artifacts: list, then download by ID
bk artifacts list 4609 -p frontend-ops --json | \
  jq -r '.[] | "\(.id)\t\(.path)\t\(.file_size)"'
bk artifacts download <artifact-id> -p frontend-ops --build 4609   # preserves the artifact's path
bk build download 4609 -p frontend-ops                             # ALL artifacts for the build
```

## Finding why a build failed

1. `bk build view <n> -p <pipeline> --json | jq '.jobs[] | select(.state=="failed") | .id'`
2. `bk job log <job-uuid> --agent` — the windowed LLM view usually surfaces the
   real error. For deep digging, dump raw logs and grep:
   ```bash
   mkdir -p /tmp/bk-<n>/logs
   bk job log <job-uuid> --no-timestamps > /tmp/bk-<n>/logs/<job-uuid>.log
   grep -inE 'error|fail|exit code|fatal|panic|denied|timed? ?out' /tmp/bk-<n>/logs/*.log
   ```
3. Watch for red-herring noise: CI logs often embed a repeated unrelated error
   string near the top. The real failure is often further down — check the
   final failing step and the `exit status`/`exit code` line. Use
   `sed -n '<start>,<end>p'` around a grep hit for clean context rather than
   `grep -C`, which gets swamped by repeated noise lines.

## Useful `build list` filters (server-side unless noted)

`--state <state>` · `--since 24h` / `--until 1h` · `--branch main` ·
`--creator alice@company.com` · `--commit <sha>` · `--meta-data key=value` ·
`--message deploy` (client-side) · `--duration ">20m"` (client-side) ·
`--limit N` / `--no-limit`.

## Notes

- Build/job/artifact JSON is the source of truth — pipe through `jq` and pull
  the fields you need (`.number`, `.state`, `.web_url`, `.jobs[].id`,
  `.jobs[].name`, artifact `.id`/`.path`/`.file_size`).
- Job UUIDs are self-contained; `-p`/`-b` on `bk job log` are deprecated/ignored.
- `bk artifacts download` keeps the artifact's stored path (e.g. downloads to
  `output/...` or `setup/...` under CWD), so run it from a scratch dir like
  `/tmp/bk-<n>/`.
