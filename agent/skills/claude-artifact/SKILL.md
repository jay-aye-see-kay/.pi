---
name: claude-artifact
description: Fetch a claude.ai artifact as Markdown. Use when the user shares a claude.ai artifact link (claude.ai/artifact/<id>, claude.ai/code/artifact/<uuid>, preview.claude.ai/...), gives an artifact ID, or asks to fetch, read, save or download an artifact.
only-on-hosts: ["jrose-04LCLG"]
---

# Fetch claude.ai artifacts

Artifacts sit behind claude.ai login, so web fetch, curl and headless browsers can't read them. Use the `claude_artifact_fetch` tool. It isn't declared to you or listed in codemode's description, but codemode scripts can call it:

```js
const r = await tools.claude_artifact_fetch({ url: "<url-or-id>" });
return r; // { html, md, log, info, connectors? }
```

- `html`: the raw page, e.g. `/private/tmp/claude-artifact/<id>/index.html`
- `md`: pandoc conversion of the page; read this
- `log`: claude's stream-json log, for debugging
- `info`: the Artifact tool's own result text (version, size)
- `connectors`: connector (MCP) calls found in the page source, e.g. `Atlassian Rovo: searchJiraIssuesUsingJql (watchTool)`. Pages that use connectors fetch live data in the browser, so `page.md` only has their placeholder text; say so and report the connector calls instead.

Notes:
- Takes a full URL (keep any `?sk=` share key), a short ID (`TdyPb7Ten6zCCDkSEgHphy` → `claude.ai/artifact/<id>`), or a UUID (→ `claude.ai/code/artifact/<uuid>`). Anything else is rejected. Optional `out_dir`.
- Takes about 10s, whatever the artifact's size.
- `page.md` is an exact conversion of the page HTML. Mermaid diagrams stay as fenced code. Content rendered by scripts (charts, live connector data) is only in `index.html`, if at all. `page.md` can be long, so check its size before reading the whole thing.
- On failure the call throws with the reason and the log path. Tell the user the reason and don't try another way to fetch it.
- `metadata: true` adds a second, plain read (what Claude Code's TUI sees), about 10s and $0.03 more. It returns `metadata` (the header: owner, sharing, version, stored declaration; raw HTML removed), `metadata_file` (the full reply) and `declaration`, the connectors the page was published with, e.g. `{"mcp":{"servers":[{"server":"Atlassian Rovo","tools":["searchJiraIssuesUsingJql"]}]}}`. Use it when the user asks who owns or shared an artifact, or exactly which connectors it uses; `connectors` from the source scan is usually enough.
- Pages that use connectors fetch live data in the viewer's browser, so no read gets that data. To show it, run the same query through pi's own MCP (e.g. `mcp__atlassian` for Atlassian Rovo) using the inputs found in `index.html`.
- The user can also run `/artifact <url-or-id>` themselves.

## How it works

Only Claude Code's Artifact tool can read artifacts. `agent/extensions/claude.ts` runs `claude -p` with Haiku, only that tool, and one write permission: `Edit(<out_dir>/**)`. The model makes one call, `{"action":"read","path":"index.html","out_dir":…}`, which saves the raw HTML to disk, so the page never enters a model's context. pandoc then converts it locally.

## Auth

The tool runs in pi's main process, outside the sandbox, with the user's normal `claude` login. No token is stored for it. If it reports not logged in or a 401, the user needs to run `claude` then `/login` in a normal terminal.
