---
name: agentsview-history
description: Search and read previous AI agent chat sessions via the agentsview CLI. Use when the user references past work, prior conversations, "what did we do before", or you need context from earlier sessions across any agent
---

# agentsview - Previous Chat History

`agentsview` syncs every local AI coding agent's sessions into a SQLite DB and
exposes them through a programmatic `session` command group. All subcommands
take `--format json` for machine-readable output. Reads the DB directly; no
server required.

## Commands

```sh
# find past sessions by content (fast tokenized full-text search)
agentsview session search "devbox version pin" --fts --format json

# regex or scoped search
agentsview session search "TODO|FIXME" --regex --in messages,tool_result --format json

# list/filter sessions (cursor-paginated)
agentsview session list --project myrepo --date-from 2026-06-01 --format json
agentsview session list --agent claude --outcome failure --format json

# session metadata, signals, health
agentsview session get <id> --format json

# full conversation, windowed
agentsview session messages <id> --limit 50 --from 0 --direction asc --format json

# every tool call with inputs/results
agentsview session tool-calls <id> --format json

# token usage + cost
agentsview session usage <id> --format json

# raw source JSONL
agentsview session export <id>
```

## Typical flow

1. `session search` to locate relevant prior chats -> get `session_id`.
2. `session messages <id>` to pull the conversation into context.
3. `session tool-calls <id>` if you need the commands/edits that were run.

## Notes

- Secrets are auto-redacted; pass `--reveal` only when explicitly needed.
- Subagent/automated/one-shot sessions are excluded by default; add
  `--include-children`, `--include-automated`, `--include-one-shot`.
- `--fts` needs a binary built with the fts5 tag (official release/homebrew
  builds have it). Without it, search still works but slower.
- Ensure data is current: `agentsview sync` syncs from disk.
- `--server` (remote daemon) is not yet implemented; run on the same machine as
  the DB.
