---
name: web-search-and-fetch
description: Search the web and fetch page content via the Exa MCP (mcp__exa). Use when the user wants to search the web, look something up online, or read a URL's content.
---

# Web search and fetch (Exa)

Exa is the `mcp__exa` MCP server, called from `codemode`. Use the helpers in [lib.js](lib.js) instead of calling the tools directly. Load the lib first in every script:

```js
const web = new Function("tools", await tools.read({ path: "~/.pi/agent/skills/web-search-and-fetch/lib.js" }))(tools);

const hits = await web.search("blog post comparing bun and node HTTP performance", { n: 5 });
return web.show(hits);            // title (date), URL, first 300 chars of highlights; show(hits, 0) = titles only

const pages = await web.fetch([hits[0].url, hits[1].url], { max: 8000 });   // [{ url, title, text } | { url, error }]
```

- `search(query, { n, objective })` returns `[{ title, url, published, author, text }]`, where `text` is the highlights (2–8KB per hit). Filter in the script and return only what you need.
- `fetch(url | urls, { max })` fetches each URL in parallel and returns its markdown. `max` is the character limit per page (Exa's default is 3000). A failed URL returns `{ url, error }` instead of throwing.
- To run several queries, use `Promise.all(queries.map((q) => web.search(q)))`.

## Gotchas

- **`objective` is required** by the raw `mcp__exa__web_search_exa`, alongside `query` so we wrap it for easier use. For raw arguments, `await describeTool(...)` (it's async, so without `await` you get `{}`).
- **Query style:** describe the ideal page rather than listing keywords. `category:people` and `category:company` search LinkedIn profiles and companies.
- **Freshness:** Exa serves cached pages that can be **weeks stale**, including `…/releases/latest` and changelogs. Tested 2026-10: it reported mise 2026.9.1 as the latest version when 2026.9.18 was out. For "latest version" or "current status" questions, check the primary source. For GitHub projects, use `gh api repos/<owner>/<repo>/releases/latest --jq .tag_name`. Run `date` to know what "recent" means.
- **Rate limits:** Multiple sub-agents using Exa in parallel will hit rate limits, but sequential use of Exa rarely does.

## When to use a subagent

- **Main agent:** quick lookups. One script that searches, fetches and filters down to a short result is fine.
- **Subagent:** anything that fetches full pages, batches URLs, or iterates (search → fetch → search). Have it return the synthesised answer with source URLs.
