---
name: glean
description: Search Culture Amp company knowledge (Confluence, Jira, Slack, GDrive, Gmail, Notion…), ask the Glean AI assistant, and look up people/org ("who is…", "who works on…", "who reports to…", org chart, new starters). Also "what did I work on" via my Glean activity. Use for internal/company info, docs, tickets, "what do we know about X".
only-on-hosts: ["jrose-04LCLG"]
---

# Glean

Glean is the `mcp__glean` MCP server, called from `codemode`. Its server instructions and tool descriptions explain chat vs search, filters and the search → read_document flow (`describeNamespace("mcp__glean")`). Raw outputs are huge (search ≈4.5KB/hit, a Confluence page ≈40KB of escaped HTML, a day of activity ≈25KB), so use the helpers in [lib.js](lib.js) — load it first in every script:

```js
const glean = new Function("tools", await tools.read({ path: "~/.pi/agent/skills/glean/lib.js" }))(tools);
```

| You want to… | Script |
|---|---|
| A question / "what do we know about X" | `return glean.chat("…")` → answer + `[^n]` source links. Follow-ups: restate what's needed in the message (or one `"Q: … A: …"` context string — separate Q/A array items make it answer the old Q) |
| Find the actual docs | `return glean.show(await glean.search({ query: "short keywords", app: "confluence" }))` |
| Read docs in full | `glean.read([url1, url2], maxChars)` → `[{ title, url, text }]` (one call for many URLs) |
| Who is X / X's manager | `(await glean.people("Jane Doe")).people` → `{ name, title, department, location, email, startDate, manager, slack }` |
| X's direct reports | `glean.people('reportsto:"Jane Doe"')` |
| New starters in a period | `(await glean.hires("2026-05-01", "2026-10-03")).filter(p => /Engineering/.test(p.department)).map(glean.line).join("\n")` — always filter + map in-script (raw ≈80 people) |
| What did I work on / standup | `glean.activity(start, endExclusive)` → `when(UTC) ACTION [source] title url` (calendar dropped). Titles only ("Thread between Jack and Shay") — get content via the linked Slack threads (slack skill) or `glean.chat("Summarise what I worked on …")`, and PRs via `gh search prs --author=@me --updated=">=DATE"` (GitHub isn't in activity). Times are UTC (AEST = UTC+10) |
| Any other tool | `glean.call("memory", { action: "read", category: "ActiveProjects" })` → text |

`chat` is slow-ish (≈5s) but cheapest on context; prefer it for questions and `search` when you need sources or lists. Run independent calls with `Promise.all`. Delegate broad research (many searches/reads) to a subagent that returns the answer + URLs.

## Gotchas

- Every tool requires `_user_goal`; helpers fill it (`glean.setGoal("…")` to be accurate).
- `search` is keyword matching: short discriminative terms, no sentences, no OR/AND. `app:` values: `confluence|jira|slack|gdrive|gmail|notion|github…`. `from:`/`owner:` take a name or `"me"`.
- Prefer the Atlassian skill for reading Confluence pages/Jira issues (cleaner markdown); `glean.read` is for anything else or mixed sources.
- **employee_search** matches name/title/department/location — not skills or projects ("who works on X" → `chat`).
  - Shows max 16 people; `cursor` is ignored. `people()` returns the real `total` and `notShown`; `hires()` bisects date windows to get everyone.
  - A keyword + `startafter:` (e.g. `engineering startafter:2026-05-10`) returns **0**. Query dates alone, then filter on `department`.
  - "Engineering" is split across departments: Engineering, Site Reliability Engineering, Data & Machine Learning Engineering, Security Infrastructure, Data Science, Data Analytics, Tech Delivery, Delivery. Decide which count.
  - `startDate` can be a rehire/transfer date. Titles `Contractor…` and `SVC…` accounts are in results — say whether you excluded them.
  - For "who does X report to", look X up and read `manager` — don't use `reportsto:`.
- `memory`, `upload_artifact`, `share_artifact` and `create_image` write to Glean — only when asked.
