---
name: glean
description: Search Culture Amp company knowledge (Confluence, Jira, Slack, GDrive, Gmail, Notion…) and ask the Glean AI assistant via mcporter CLI. Use for internal/company info, docs, tickets, "what do we know about X", or people/org lookups ("who is…", "who works on…", "who reports to…", org chart).
only-on-hosts: ["jrose-04LCLG"]
---

## Quick reference

```bash
# Ask the Glean AI assistant — synthesized prose answer across all sources
mcporter call glean.chat message="How does deploy rollback work for the analytics service?"

# Exact document retrieval — filter by connector with app=
mcporter call glean.search query="deploy rollback runbook" app=confluence

# Fetch full content of specific document URL(s)
mcporter call glean.read_document urls='["https://cultureamp.atlassian.net/wiki/spaces/SRE/pages/123"]'

# People / org lookup
mcporter call glean.employee_search query="Jane Doe"
```

## chat vs search

- **`chat`** — questions, synthesis, "what do we know about X". Returns a clean prose answer with reasoning. Start here for most questions. Pass `context='["earlier msg", ...]'` for follow-ups.
- **`search`** — exact document retrieval when you need the actual source docs. Output is **noisy** (base64 cursor + nested metadata per hit) — prefer a subagent, or grep the fields you need.

## Filter tips

`search`:
- `app=confluence|jira|slack|gdrive|gmail|gmailnative|notion|asana|gong|…` — scope to one connector.
- `before=YYYY-MM-DD` / `after=YYYY-MM-DD` — date range. `channel=…` — Slack channel.

`employee_search` (combine filters in the single `query` string):
- Returns a rich record: title, department, location, email, start date, Jira/Slack profile links, and a `manager` block (name, title, report counts).
- `reportsto:"email or name"` → a manager's direct-report roster.
- `roletype:"manager"` / `roletype:"individual contributor"`.
- `startafter:YYYY-MM-DD` / `startbefore:YYYY-MM-DD`, `sortby:hire_date_ascending|hire_date_descending|most_reports`.
- Matches on people **attributes** (name/title/department/location), NOT skills or projects — for "who works on <tech/project>" use `chat` or `search`.
- For "who does X report to", look X up and read the `manager` field — don't use `reportsto:` for that.

### employee_search gotchas (learned the hard way)

- **Don't combine a department/title keyword with `startafter:`** — e.g. `engineering startafter:2026-05-10` returns ZERO results even when such people exist. The keyword filter and date filter conflict. There is also no working `department:` prefix. Instead: run `startafter:Y sortby:hire_date_descending` **without** the keyword, then filter by the `department:` field in the results. Confirm with a keyword-only query (`"<dept name>" sortby:hire_date_descending`, no date filter).
- **Results are silently capped (~16 shown).** The `statistics[]` block at the bottom gives the true total (e.g. `datasource=people: 21`) and `peopleNotShown: notShownCount: N` shows how many are hidden. `cursor=` and `pageSize=` are **ignored** — you cannot paginate past the cap. Workaround: split the date range into narrower windows (`startafter:X startbefore:Y`) to force different slices. Plan 2–3 queries for a multi-month range.
- **"Engineering" is fragmented into sub-departments** that a keyword for "Engineering" won't match: Engineering, Site Reliability Engineering, Data & Machine Learning Engineering, Security Infrastructure, Data Science, Data Analytics, Tech Delivery. Decide upfront which count, and filter on the `department:` field after retrieval.
- **Parsing trap:** each person record contains a nested `manager:` sub-block (and `directReports[]` for managers) with the SAME field names (name/email/startDate/title/department). Naïve grep/regex will silently pull manager data. Only read the top-level person fields; skip everything inside `manager:`/`directReports[]`.
- **`statistics[]` collapses rare depts into `department=other`** — absence from the facet breakdown does NOT mean no such hires. Always check `peopleNotShown` and use date-window splitting when it's > 0.
- **`datasourceToProfileLink`** lists connectors (SLACK, JIRA, SALESFORCE) in no guaranteed order — don't assume SLACK is first; match on the connector name.

## When to use subagent

Offload most use of glean to a subagent to prevent context pollution.

- **Main agent** — a single quick `chat` or a one-off lookup where the answer is short.
- **Subagent** — anything that runs `search` (noisy output), fetches full documents, pulls large `employee_search` rosters, or iterates (search → read_document → chat). Have it do the digging and return just the synthesized answer plus source URLs.
