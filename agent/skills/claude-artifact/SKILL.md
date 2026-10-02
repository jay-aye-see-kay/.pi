---
name: claude-artifact
description: Fetch a claude.ai artifact as Markdown. Use when the user shares a claude.ai artifact link (claude.ai/artifact/<id>, claude.ai/code/artifact/<uuid>, preview.claude.ai/...), gives an artifact ID, or asks to fetch, read, save or download an artifact.
only-on-hosts: ["jrose-04LCLG"]
---

# Fetch claude.ai artifacts

Artifacts sit behind claude.ai login, so web fetch, curl and headless browsers can't read them. Use [fetch-artifact.sh](fetch-artifact.sh):

```bash
~/.pi/agent/skills/claude-artifact/fetch-artifact.sh <url-or-id> [out_dir]
```

It prints the file paths only:

```
html: /private/tmp/claude-artifact/<id>/index.html   # the raw page
md:   /private/tmp/claude-artifact/<id>/page.md      # pandoc conversion; read this
log:  /private/tmp/claude-artifact/<id>/claude.jsonl # claude's stream, for debugging
```

- Takes a full URL, a short ID (`TdyPb7Ten6zCCDkSEgHphy` → `claude.ai/artifact/<id>`), or a UUID (→ `claude.ai/code/artifact/<uuid>`).
- Takes about 10s, whatever the artifact's size. Use a bash `timeout` of 120.
- `page.md` is an exact conversion of the page HTML. Mermaid diagrams stay as fenced code. Content rendered by scripts (charts, interactive parts) is only in `index.html`, if at all. `page.md` can be long, so check its size before reading the whole thing.
- Exits 0 on success. On failure it exits non-zero and writes the reason to stderr. Tell the user the reason and don't try another way to fetch it. `claude.jsonl` has the full tool call and result.

## How it works

Only Claude Code's Artifact tool can read artifacts. The script runs `claude -p` with Haiku, only that tool, and one write permission: `Edit(<out_dir>/**)`. The model makes one call, `{"action":"read","path":"index.html","out_dir":…}`, which saves the raw HTML to disk, so the page never enters a model's context. pandoc then converts it locally.

## Auth

The sandbox can't read `claude`'s keychain login or write `~/.claude`. So the script uses `/tmp/claude-artifact/.config` as the config dir and a long-lived token from `$PI_CLAUDE_OAUTH_TOKEN`, which `agent/extensions/secrets.ts` loads from the keychain. If the script exits 3 (token missing) or reports a 401, the user needs to do this outside pi:

```bash
claude setup-token
security add-generic-password -U -a "$USER" -s pi-claude-oauth-token -w
```

Then restart pi.
