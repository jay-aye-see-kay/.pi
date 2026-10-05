// Exa web search/fetch helpers for codemode. Load with:
//   const web = new Function("tools", await tools.read({ path: "~/.pi/agent/skills/web-search-and-fetch/lib.js" }))(tools);
// Then: web.search / fetch / show / call. Keep small: read on every load.

// Any exa tool → text. Throws on isError.
const call = async (tool, args = {}) => {
  const r = await tools[`mcp__exa__${tool}`](args);
  const t = (r.content ?? []).map((c) => c.text ?? "").join("\n");
  if (r.isError) throw new Error(`exa ${tool}: ${t}`.slice(0, 600));
  return t;
};

// Search → [{ title, url, published, author, text }] (text = highlights, ~2–8KB per hit).
// Exa requires `objective` but it barely affects ranking (tested), so it defaults to the query.
const search = async (query, { n = 5, objective = query } = {}) => {
  const t = await call("web_search_exa", { query, objective, numResults: n });
  return t.split(/\n+---\n+/).filter((b) => /^URL: /m.test(b)).map((b) => {
    const f = (k) => b.match(new RegExp(`^${k}: (.*)$`, "m"))?.[1].trim();
    const na = (v) => (v && v !== "N/A" ? v : undefined);
    return { title: f("Title"), url: f("URL"), published: na(f("Published"))?.slice(0, 10), author: na(f("Author")),
      text: (b.split(/\nHighlights:\n/)[1] ?? "").trim() };
  });
};

// Fetch page(s) as markdown → [{ url, title, text, error }], one parallel call per URL so results map cleanly.
// `max` is chars per page (Exa default 3000). Failures come back as { url, error } rather than throwing.
const fetch = async (urls, { max = 8000 } = {}) => Promise.all([urls].flat().map(async (url) => {
  try {
    const t = await call("web_fetch_exa", { urls: [url], maxCharacters: max });
    const err = t.match(/^Error fetching \S+: (.*)$/m)?.[1];
    if (err && !/^URL: /m.test(t)) return { url, error: err };
    return { url, title: t.match(/^# (.*)$/m)?.[1], text: t.replace(/^# .*\nURL: .*\n+/, "").trim() };
  } catch (e) { return { url, error: String(e.message ?? e) }; }
}));

// Search hits → compact lines for returning to the model. n = highlight chars per hit (0 = titles only).
const show = (hits, n = 300) => hits.map((h) => `${h.title} (${h.published ?? "n.d."})\n  ${h.url}` +
  (n ? `\n  ${h.text.replace(/\s+/g, " ").slice(0, n)}` : "")).join("\n");

return { call, search, fetch, show };
