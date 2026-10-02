---
name: atlassian
description: Query and manage Jira and Confluence. Use when the user mentions Jira (epics, issues, tickets, bugs, stories, tasks, sprints, FEF-123 style keys) or Confluence (wiki, pages, docs, spaces, atlassian.net/wiki links).
only-on-hosts: ["jrose-04LCLG"]
---

# Atlassian (Jira + Confluence)

Atlassian is the `mcp__atlassian` MCP server, called from `codemode`. Tool descriptions cover parameters, CQL fields and examples (`describeTool("mcp__atlassian__<tool>")`). Every call needs `cloudId` and returns raw REST JSON (5–12KB per issue/page of `self`/avatar noise), so use the helpers in [lib.js](lib.js) — load it first in every script:

```js
const atl = new Function("tools", await tools.read({ path: "~/.pi/agent/skills/atlassian/lib.js" }))(tools);
```

| You want to… | Script |
|---|---|
| Read an issue | `return atl.issue("FEF-3011")` → header, people, parent, description (markdown), last 5 comments. `{ comments: 0, fields: ["customfield_10020"] }` to tune |
| Find issues (JQL) | `return atl.jql('project = FEF AND assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC')` → `KEY [Status] Assignee: Summary` lines; `{ max: 200, fields: ["parent"] }` |
| Epic children | `atl.jql("parent = FEF-1234")` |
| Read a page | `return atl.page(urlOrId)` → `# title`, url, version, markdown body (also takes `/wiki/x/…` tiny links) |
| Find pages (CQL) | `return atl.cql('space = DE AND type = page AND lastmodified >= now("-4w") ORDER BY lastmodified DESC')` → `id \| date \| space \| title \| url`; pages up to 100 (`atl.cql(q, 300)`), notes `(N of TOTAL)` if cut. `title ~ "devbox"`, `text ~ "…"`, `creator = currentUser()` |
| Don't know where it is | `return atl.search("replacing devbox")` — Rovo natural-language search over Jira + Confluence (costs Rovo credits) |
| Anything else | `await atl.call("getConfluencePageDescendants", { pageId })` → parsed JSON (cloudId filled; throws on `isError`). Trim before returning |
| Create / edit / comment / transition / link | [references/writing.md](references/writing.md) — **writes: only when asked** |

Run independent reads with `Promise.all`. For big sweeps (many issues/pages) use a subagent that returns the answer + links.

## Gotchas

- JQL `maxResults` is fine below 50 despite "(50-100)" in the schema; `atl.jql` pages via `nextPageToken`. Use `searchResultMode: "count"` (via `call`) for counts only.
- Bodies: reads come back as markdown via the helpers; writes default to markdown too (`contentFormat`). Confluence `contentFormat: "html"` is the round-trip-safe option when editing pages with macros/panels.
- Rovo `search` hit text contains `!--<url>` link markers — the helper strips them.
- `fetch` only takes ARIs (`ari:cloud:…`), not URLs or keys.
- Errors (missing issue, no permission) throw with the Jira message, e.g. `Issue does not exist or you do not have permission to see it.`

## IDs

cloudId `cultureamp.atlassian.net` · Jack's account `5e7ad7871e65980c42a8c01e` · Shay `712020:ecc3f064-b098-4aed-8a2c-d13896f902a4` · Felicity `712020:a946beeb-8b9a-4ec7-b1f1-ee20f4b29b86`. Others: `atl.call("lookupJiraAccountId", { searchString: "Name" })` → `data.users.users[].accountId`. Team project: **FEF** (components in [writing.md](references/writing.md)).
