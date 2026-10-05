---
name: atlassian
description: Query and manage Jira and Confluence. Use when the user mentions Jira (epics, issues, tickets, bugs, stories, tasks, sprints, FEF-123 style keys) or Confluence (wiki, pages, docs, spaces, atlassian.net/wiki links).
only-on-hosts: ["jrose-04LCLG"]
---

# Atlassian (Jira + Confluence)

Atlassian is the `mcp__atlassian` MCP server (v2), called from `codemode`. It has three layers:

1. **Primary tools**, callable directly: `getJiraIssue`, `searchJiraIssuesUsingJql`, `createJiraIssue`, `editJiraIssue`, `transitionJiraIssue`, `addOrEditJiraIssueComment`, `getConfluenceContent`, `searchConfluence`, `createConfluenceContent`, `updateConfluenceContent`, `search` (Rovo), `getGraphContext`/`getGraphObject`/`addGraphContext` (Teamwork Graph), `getLoomVideo`, `atlassianUserInfo`.
2. **`discover`**: finds any of the other ~300 operations, such as comments, worklogs, transitions, links, users, spaces, page trees, sprints, boards and Compass. It returns the exact name, inputs and risk tier.
3. **`executeRead` / `executeWrite` / `executeDestructive`** run a discovered operation by name. Only use names returned by `discover` or listed above; never guess.

Run `describeTool("mcp__atlassian__<tool>")` for a primary tool's parameters. Responses are JSON wrapped in `{ data }`, so use the helpers in [lib.js](lib.js). Load lib.js first in every script:

```js
const atl = new Function("tools", await tools.read({ path: "~/.pi/agent/skills/atlassian/lib.js" }))(tools);
```

| You want to… | Script |
|---|---|
| Read an issue | `return atl.issue("FEF-3011")` → header, people, parent, description (markdown), last 5 comments. Tune with `{ comments: 0, fields: ["customfield_10020"] }` |
| Find issues (JQL) | `return atl.jql('project = FEF AND assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC')` → `KEY [Status] Assignee: Summary` lines. Options: `{ max: 200, fields: ["parent"] }` |
| Epic children | `atl.jql("parent = FEF-1234")` |
| Read a page | `return atl.page(urlOrId)` → `# title`, url, version, markdown body. Also takes `/wiki/x/…` tiny links, blog, whiteboard, database and folder URLs |
| Find pages (CQL) | `return atl.cql('space = DE AND type = page AND lastmodified >= now("-4w") ORDER BY lastmodified DESC')` → `id \| date \| space \| title \| url`. Returns up to 100 pages (`atl.cql(q, 300)` for more) and adds `(N of TOTAL)` if cut. Other filters: `title ~ "devbox"`, `text ~ "…"`, `creator = currentUser()` |
| Don't know where it is | `return atl.search("replacing devbox")`. This is Rovo natural-language search across Jira, Confluence, Atlas and connected apps, and it costs Rovo credits. Options: `{ targetApp: "JIRA"\|"CONFLUENCE", mode: "ENHANCED" }` |
| Find an operation | `return atl.discover("list confluence page children")` → `name [executeTool]: summary` plus the inputs (`*` marks required ones) |
| Anything else | `await atl.call("getConfluenceContentDescendants", { contentId, depth: 1 })` → parsed `data`. It fills in cloudId, runs primary tools directly and runs everything else through `executeRead`. Writes need a third argument: `atl.call(name, inputs, "Write")` or `"Destructive"`. It throws on errors. Trim the result before returning |
| Create / edit / comment / transition / link | [references/writing.md](references/writing.md). **Only write when asked** |

Run independent reads with `Promise.all`. For big sweeps (many issues or pages), use a subagent that returns the answer plus links.

## Gotchas

- **Views**: `getJiraIssue` and JQL default to `view: "compact"`, which drops every field except a few defaults (no parent, components, reporter or comments). The `fields` option only takes effect with `view: "full"`; the helpers handle this. `view: "evidence"` adds issue links, subtasks and all custom fields mapped to their labels.
- **Custom fields** come back under `fields.customFields`, keyed by label (`{ id, value }`), not as top-level `customfield_*` keys. Field IDs differ per site.
- **Comments** are not part of `getJiraIssue` any more. Use `listJiraIssueComments` (`orderBy: "-created"`); `atl.issue` already does.
- **Rich text** comes back as HTML (with a `warning`) whenever markdown can't represent it: panels, @mentions, media, statuses. `atl.md(html)` turns it into rough markdown for reading. To **edit** such a body, read it with `responseContentFormat: "html"` and write it back with `contentFormat: "html"`, or the rich content is lost.
- JQL: `maxResults` is at most 100, and pages are fetched via `nextPageToken` (`atl.jql` does this). For counts only, use `atl.call("searchJiraIssuesUsingJql", { jql, searchResultMode: "count" })` → `totalCount`.
- `search` (Rovo) needs `limit >= 10`. Its snippets contain `!--<url>` link markers, which the helper strips. `getGraphContext` also costs Rovo credits.
- `getConfluenceContent` defaults to `detail: "summary"` (an excerpt only). Ask for `detail: "full"` to get the body, and use `"outline"` for a cheap heading tree.
- Errors (missing issue, no permission) throw with the Jira message, e.g. `Issue does not exist or you do not have permission to see it.`

## IDs

- cloudId: `cultureamp.atlassian.net`; the UUID is `5b094b66-6935-4e1b-86b0-d4722bcafaf4`.
- Account IDs: Jack `5e7ad7871e65980c42a8c01e`, Shay `712020:ecc3f064-b098-4aed-8a2c-d13896f902a4`, Felicity `712020:a946beeb-8b9a-4ec7-b1f1-ee20f4b29b86`.
- Anyone else: `atl.call("lookupJiraAccountId", { query: "Name" })` → `[{ accountId, displayName }]`. For assignees, `listJiraIssueAssignableUsers` returns only people who can be assigned.
- Team project: **FEF** (components are listed in [writing.md](references/writing.md)).
