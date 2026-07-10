---
name: hotel-docs
description: Search Culture Amp internal/company engineering knowledge via the hotel MCP (mcporter CLI) — package & API docs, Kaizen components, engineering standards, tech radar, and the DX Insights Metabase. Use for "how do we do X at Culture Amp", CA package/API usage, Kaizen UI components, "what's our standard for…", "is <tech> adopt/retire", or internal DX metrics.
only-on-hosts: ["jrose-04LCLG"]
---

## Quick reference

```bash
# Search internal docs — packages, APIs, Kaizen components, company systems (start here)
mcporter call hotel.search_package_docs query="kaizen button component"
mcporter call hotel.search_package_docs query="analytics event tracking" language=typescript limit=5

# What packages are searchable?
mcporter call hotel.list_packages

# Engineering standards — list/search, then fetch full authoritative content by id
mcporter call hotel.list_engineering_standards query="backend"
mcporter call hotel.get_engineering_standard_by_id id="<id-from-list>"

# Tech radar — is a technology adopt / experiment / contain / retire?
mcporter call hotel.list_tech_radars query="graphql"

# DX Insights (Metabase) — get schema FIRST, then read-only SQL
mcporter call hotel.dx_insights_get_schema
mcporter call hotel.dx_insights_query query="SELECT ... LIMIT 100"

# What is this server?
mcporter call hotel.about_self
```

## Tools

- **`search_package_docs`** — the primary tool. Authoritative, up-to-date CA docs for
  packages, APIs, Kaizen components, and company-specific systems. Args: `query`
  (space-separated terms, required), `language?`, `limit?`. An invalid `language`
  returns the list of valid ones.
- **`list_packages`** — names available to `search_package_docs`.
- **`list_engineering_standards`** — search/list standards; returns `id`, `title`,
  `status`, and an **`ai_summary` (may be incomplete/inaccurate)**. `status` defaults
  to `current`+`adopting`. Always follow up with `get_engineering_standard_by_id`
  before relying on a standard.
- **`get_engineering_standard_by_id`** — full authoritative standard text by `id`.
- **`list_tech_radars`** — tech radar entries; `category` defaults to `adopt`.
  Categories: `adopt` / `experiment` / `contain` / `retire`.
- **`dx_insights_get_schema`** → **`dx_insights_query`** — read-only (SELECT/CTE only)
  SQL against the internal DX Insights Metabase. Call the schema tool first.
- **`about_self`** — what the server is / who maintains it / data sources.

## Gotchas

- **First call is slow / "still loading".** The docs corpus (a private repo) loads
  asynchronously ~10s on cold start; the first call may return *"Culture Amp docs are
  still loading, try again in ~10 seconds"*. The server is kept warm via mcporter's
  keep-alive daemon, so just retry — subsequent calls are fast.
- **Auth (`HOTEL_GITHUB_TOKEN`).** Hotel normally authenticates via the macOS
  keychain, which the sandbox blocks — so it reads the token from
  `HOTEL_GITHUB_TOKEN` instead (bound to hotel's `github.token`; needs the hotel
  release with that env binding, from 2026-07-10). It's wired in the mcporter
  `hotel` server config:

  ```json
  "env": { "HOTEL_GITHUB_TOKEN": "${GITHUB_TOKEN}" }
  ```

  If calls report *"docs could not be loaded"*, this token / the daemon env is the
  thing to check — run `mcporter daemon restart` after any env change.
- **Standards:** treat `ai_summary` as a hint only — fetch the full standard by `id`
  before making decisions.

## When to use a subagent

`search_package_docs` and `dx_insights_query` output can be large. Offload multi-step
digging (search → read standard → cross-check) to a subagent and have it return just
the synthesized answer plus the source package/standard ids.
