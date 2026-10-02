---
name: web-search-and-fetch
description: Search the web and fetch page content. Use when user wants to search the web, look something up online, or read a URL's content.
---

# Web search and fetch (Exa)

Exa is the `mcp__exa` MCP server, called from `codemode`. Query tips, such as describing the ideal page and using `category:people` or `category:company`, are in the tool descriptions.

```js
const txt = (r) => r.content.map((c) => c.text).join("\n");

// Search. Both query and objective are required. Each hit is ~8KB of title, URL, date and highlights.
const hits = txt(await tools.mcp__exa__web_search_exa({
  query: "blog post comparing bun and node HTTP performance",
  objective: "benchmark numbers for bun vs node HTTP throughput; skip vendor marketing",
  numResults: 5,
}));

// Fetch full pages as markdown. Batch the URLs; maxCharacters is per page (default 3000).
// A failed URL comes back inline as "Error fetching <url>: …" and doesn't fail the call.
const pages = txt(await tools.mcp__exa__web_fetch_exa({ urls: ["https://a…", "https://b…"], maxCharacters: 8000 }));
```

Results are large, so filter them in-script before returning. For example, return only titles and URLs:

```js
hits.split(/\n(?=Title: )/).map((h) => h.match(/^Title: (.*)\nURL: (.*)/)?.slice(1).join(" — ")).join("\n")
```

Alternatively, run several searches in parallel with `Promise.all`.

## Freshness

Exa serves cached pages that can be **weeks stale**, including `…/releases/latest` and changelogs. Tested 2026-10: it reported mise 2026.9.1 as latest when 2026.9.18 was out. For "latest version" or "current status" questions, check the primary source. For GitHub projects, use `gh api repos/<owner>/<repo>/releases/latest --jq .tag_name`. Use `date` to know what "recent" means.

## When to use a subagent

- **Main agent:** quick lookups; one script that searches and fetches and filters to a short result is fine.
- **Subagent:** anything that fetches full pages, batches URLs, or iterates (search → fetch → search). Have it return the synthesised answer plus source URLs.
