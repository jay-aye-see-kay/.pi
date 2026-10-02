---
name: hotel-docs
description: Search Culture Amp internal/company engineering knowledge via the hotel MCP — package & API docs, Kaizen components, engineering standards, tech radar, and the DX Insights Metabase. Use for "how do we do X at Culture Amp", CA package/API usage, Kaizen UI components, "what's our standard for…", "is <tech> adopt/retire", or internal DX metrics.
only-on-hosts: ["jrose-04LCLG"]
---

# Hotel docs

Hotel is the `mcp__hotel` MCP server, called from `codemode`. Tool descriptions cover the args (`describeTool("mcp__hotel__<tool>")`). Outputs are plain text, except the two DX Insights tools, which return JSON. `const txt = (r) => r.content.map((c) => c.text).join("\n");`

| You want to… | Script |
|---|---|
| CA package / API / Kaizen docs (start here) | `return txt(await tools.mcp__hotel__search_package_docs({ query: "kaizen button component", limit: 3 }))`. Add `language: "typescript"` to narrow it; an invalid language lists the valid ones. Each hit is ~1KB with code |
| Which packages are covered | `tools.mcp__hotel__list_packages({})` |
| An engineering standard | `list_engineering_standards({ query: "compute" })` → `get_engineering_standard_by_id({ id })` (~4KB). The list query is loose ranking (~1.3KB per standard), so trim to ids with the recipe below. `ai_summary` is a hint and may be wrong; read the full standard. `status` is an array, defaulting to `["current", "adopting"]` |
| Tech radar: adopt / experiment / contain / retire | `list_tech_radars({ query: "graphql", category: ["adopt", "experiment", "contain", "retire"] })`. `category` is an **array** and defaults to `["adopt"]`, so without it `query: "graphql"` misses GraphQL, which is `contain`. `query` matches name/description, not the radar (Front end, Back end…), so filter by radar in-script with the recipe below |
| DX Insights metrics (Postgres via Metabase, read-only SELECT/CTE) | Use the schema recipe below first, then `dx_insights_query({ query })` |

```js
// Standards → "id — title (status)" lines
const std = txt(await tools.mcp__hotel__list_engineering_standards({ query: "compute" }));
std.split(/\n(?=title: )/).map((s) => `${s.match(/^id: (.*)$/m)?.[1]} — ${s.match(/^title: (.*)$/m)?.[1]} (${s.match(/^status: +(.*)$/m)?.[1]})`).join("\n");

// Front-end retire entries (entries are separated by "---"; "- radar: Front end" line)
const rad = txt(await tools.mcp__hotel__list_tech_radars({ category: ["retire"] }));
rad.split(/\n---\n/).map((e) => e.trim()).filter((e) => /^- radar: Front end/m.test(e)).map((e) => e.split("\n")[0]);
```

Run independent calls with `Promise.all`.

## DX Insights

```js
const txt = (r) => r.content.map((c) => c.text).join("\n");
// The schema is ~30KB of JSON (33 tables). Return one line per table, then the column details for the tables you need.
const s = JSON.parse(txt(await tools.mcp__hotel__dx_insights_get_schema({})));
const tables = s.tables.map((t) => `${t.name}: ${t.columns.map((c) => c.name).join(", ")}`).join("\n");
const cols = (name) => s.tables.find((t) => t.name === name).columns.map((c) => `${c.name} ${c.type} — ${c.description ?? ""}`).join("\n");

// Query results are { columns, rows: [[…]], truncated }. Convert them to objects.
// e.g. builds per repo, last 30 days (builds has no repo column: join pipelines)
const r = JSON.parse(txt(await tools.mcp__hotel__dx_insights_query({ query:
  "SELECT p.repo_full_name, count(*) n FROM builds b JOIN pipelines p ON p.id = b.pipeline_id WHERE b.created_at >= now() - interval '30 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 5" })));
const rows = r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c.name, row[i]])));
```

## Gotchas

- **The first call after pi starts may return "Culture Amp docs are still loading, try again in ~10 seconds".** The corpus loads asynchronously, so wait and retry.
- **"docs could not be loaded"** means hotel's GitHub auth failed. Check `hotel doctor` and `gh auth status`, then reconnect hotel from `/mcp`.
- To check DX data is fresh, look at `max(created_at)` or the table's equivalent date column.
- For long multi-step digging (search → read standard → cross-check), use a subagent that returns the answer plus the package or standard ids.
