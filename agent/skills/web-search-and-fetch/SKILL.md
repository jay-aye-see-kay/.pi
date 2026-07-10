---
name: web-search-and-fetch
description: Search the web and fetch page content. Use when user wants to search the web, look something up online, or read a URL's content.
---

## Quick reference

```bash
# Web search — returns clean text/highlights from top results
mcporter call exa.web_search_exa \
  query="blog post comparing React and Vue performance" \
  numResults=5

# Fetch full page content as markdown (batch multiple URLs)
mcporter call exa.web_fetch_exa \
  urls='["https://example.com/a", "https://example.com/b"]' \
  maxCharacters=5000
```

## Query tips

- Describe the ideal page, not keywords: `"blog post comparing React and Vue performance"`, not `"React vs Vue"`.
- Add `category:people` or `category:company` to search LinkedIn profiles / companies — e.g. `query="category:people John Doe software engineer"`.
- Search first; when highlights aren't enough, follow up with `web_fetch_exa` on the best URLs.

## When to use subagent

Offload most use of exa to subagent to prevent context pollution

- **Main agent** — a single quick search when you just need one fact or URL and the highlights answer it.
- **Subagent** — anything that fetches full page content, batches multiple URLs, or iterates (search → fetch → search). Have it do the digging and return just the synthesized answer plus the source URLs.
