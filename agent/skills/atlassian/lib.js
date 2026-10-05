// Atlassian (Jira + Confluence) helpers for codemode, for the Atlassian MCP v2. Load with:
//   const atl = new Function("tools", await tools.read({ path: "~/.pi/agent/skills/atlassian/lib.js" }))(tools);
// Then: atl.issue / jql / page / cql / search / discover / transition / call. Keep small: read on every load.
// v2 responses are JSON wrapped in { data } (call() unwraps). Rich text comes back as HTML whenever markdown
// can't represent it, so the read helpers turn HTML into rough markdown.

const cloudId = "cultureamp.atlassian.net"; // host works anywhere a cloudId is needed (UUID 5b094b66-6935-4e1b-86b0-d4722bcafaf4)
const BROWSE = "https://cultureamp.atlassian.net/browse/";
const WIKI = "https://cultureamp.atlassian.net/wiki";

// Any operation → parsed JSON (unwraps { data }). Fills cloudId. Throws on isError with the API's message.
// Primary tools (in describeNamespace("mcp__atlassian")) are called directly. Anything else (found with discover)
// goes through execute<tier>: "Read" (default), "Write" for creates/updates, "Destructive" for deletes.
const call = async (name, args = {}, tier = "Read") => {
  const direct = `mcp__atlassian__${name}` in tools && !["executeRead", "executeWrite", "executeDestructive"].includes(name);
  const r = direct
    ? await tools[`mcp__atlassian__${name}`](name === "discover" ? args : { cloudId, ...args })
    : await tools[`mcp__atlassian__execute${tier}`]({ cloudId, name, inputs: args });
  const t = (r.content ?? []).map((c) => c.text ?? "").join("\n");
  let j; try { j = JSON.parse(t); } catch {
    // discover appends a plain-text "also matched" list after the JSON; keep it as `more`.
    const k = t.lastIndexOf("}\n");
    try { j = { ...JSON.parse(t.slice(0, k + 1)), more: t.slice(k + 1).trim() }; } catch { j = t; }
  }
  if (r.isError || j?.error === true) {
    let m = j?.message ?? t;
    try { const e = JSON.parse(String(m).match(/\{.*\}/s)?.[0] ?? m); m = e.errorMessages?.join("; ") || e.message || m; } catch {}
    throw new Error(`atlassian ${name}: ${typeof m === "string" ? m : JSON.stringify(m)}`.slice(0, 600));
  }
  return j?.data ?? j;
};

// Rough HTML → markdown for read output (v2 returns HTML for bodies with panels/mentions/media/etc).
const ent = (t = "") => t.replace(/&#0*(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const md = (s) => {
  s = String(s ?? "");
  if (!/<\/?[a-z][^>]*>/i.test(s)) return s;
  return ent(s
    .replace(/\s+data-[\w-]+="[^"]*"/g, "")
    .replace(/<h([1-6])[^>]*>/g, (_, n) => "\n\n" + "#".repeat(+n) + " ").replace(/<\/h[1-6]>/g, "\n\n")
    .replace(/<(strong|b)>/g, "**").replace(/<\/(strong|b)>/g, "**").replace(/<(em|i)>/g, "_").replace(/<\/(em|i)>/g, "_")
    .replace(/<code>/g, "`").replace(/<\/code>/g, "`").replace(/<pre[^>]*>/g, "\n```\n").replace(/<\/pre>/g, "\n```\n")
    .replace(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g, "[$2]($1)")
    .replace(/<li[^>]*>/g, "\n- ").replace(/<br\s*\/?>/g, "\n").replace(/<\/(p|div|tr|ul|ol|table|blockquote)>/g, "\n")
    .replace(/<\/t[dh]>/g, " | ").replace(/<[^>]+>/g, ""))
    .replace(/\n- \n+/g, "\n- ").replace(/\n\n+(?=- )/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
};

const who = (u) => u?.displayName ?? "-";
// A field from v2 issue JSON: system fields are top-level, custom ones sit under fields.customFields (keyed by label).
const fv = (f, k) => f[k] ?? f.customFields?.[k]?.value ?? Object.values(f.customFields ?? {}).find((c) => c?.id === k)?.value ?? null;
const row = (i) => `${i.key} [${i.fields.status?.name ?? "?"}] ${who(i.fields.assignee)}: ${i.fields.summary}`;

// One issue → compact markdown: header, people, parent, description, last `comments` comments.
const issue = async (key, { comments = 5, fields = [] } = {}) => {
  const [i, c] = await Promise.all([
    call("getJiraIssue", {
      issueIdOrKey: key, view: "full",
      fields: ["summary", "status", "issuetype", "assignee", "reporter", "parent", "priority", "labels", "components", "updated", "description", ...fields],
    }),
    comments ? call("listJiraIssueComments", { issueIdOrKey: key, orderBy: "-created", maxResults: comments }) : null,
  ]);
  const f = i.fields, cs = (c?.comments ?? []).reverse();
  return [
    `${i.key} [${f.status?.name}] (${f.issuetype?.name}) ${f.summary}  ${BROWSE}${i.key}`,
    `assignee ${who(f.assignee)} · reporter ${who(f.reporter)} · updated ${f.updated?.slice(0, 10)}` +
      (f.parent ? ` · parent ${f.parent.key} ${f.parent.fields?.summary ?? ""}` : "") +
      (f.components?.length ? ` · components ${f.components.map((x) => x.name).join(", ")}` : "") + (f.labels?.length ? ` · labels ${f.labels.join(", ")}` : ""),
    ...fields.map((k) => `${k}: ${JSON.stringify(fv(f, k))}`),
    "", f.description ? md(f.description) : "(no description)",
    ...(cs.length ? ["", `## Comments (last ${cs.length} of ${c.total})`, ...cs.map((x) => `\n**${who(x.author)}** ${x.created?.slice(0, 10)}: ${md(typeof x.body === "string" ? x.body : JSON.stringify(x.body))}`)] : []),
  ].join("\n");
};

// JQL → "KEY [Status] Assignee: Summary" lines (follows nextPageToken up to `max` issues).
// Extra fields need view "full" (compact drops anything beyond its defaults, e.g. parent).
const jql = async (q, { max = 50, fields = [] } = {}) => {
  const out = []; let nextPageToken;
  do {
    const r = await call("searchJiraIssuesUsingJql", { jql: q, fields: ["summary", "status", "assignee", ...fields], ...(fields.length ? { view: "full" } : {}), maxResults: Math.min(100, max - out.length), nextPageToken });
    out.push(...r.issues); nextPageToken = r.isLast ? undefined : r.nextPageToken;
  } while (nextPageToken && out.length < max);
  return out.map((i) => row(i) + fields.map((k) => ` | ${k}: ${JSON.stringify(k === "parent" ? i.fields.parent?.key ?? null : fv(i.fields, k))}`).join("")).join("\n") || "(no issues)";
};

// Confluence page (id, URL, or /wiki/x/<tiny> link) → "# title\nurl\n\nmarkdown body" (first `n` chars).
const page = async (idOrUrl, n = 30000) => {
  const s = String(idOrUrl);
  const p = await call("getConfluenceContent", { ...(/^https?:/.test(s) ? { content_url: s } : { content_id: s }), content_format: "markdown", detail: "full" });
  const v = p.metadata?.version;
  return `# ${p.title}\n${WIKI}/pages/viewpage.action?pageId=${p.id} (${p.type}, v${v?.number}, ${v?.createdAt?.slice(0, 10)}, spaceId ${p.spaceId})\n\n${md(p.body?.value ?? "").slice(0, n)}`;
};

// CQL → "id | lastModified | space | title | url" lines, paging via cursor up to `max` (+ "(N of TOTAL)" if cut).
const cql = async (q, max = 100) => {
  const out = []; let cursor, total;
  do {
    const r = await call("searchConfluence", { cql: q, limit: Math.min(100, max - out.length), cursor });
    out.push(...r.results); total = r.totalSize;
    cursor = r._links?.next && decodeURIComponent(r._links.next.match(/cursor=([^&]+)/)?.[1] ?? "");
  } while (cursor && out.length < max);
  return (out.map((x) => `${x.content?.id} | ${x.lastModified?.slice(0, 10)} | ${x.resultGlobalContainer?.title ?? ""} | ${ent(x.title)} | ${WIKI}${x.url}`).join("\n") || "(no results)")
    + (total > out.length ? `\n(${out.length} of ${total})` : "");
};

// Rovo search across Jira + Confluence (+ Atlas/3rd party; natural language; costs Rovo credits) → "type | title | url\n  snippet".
// opts: { limit (>=10), targetApp: "JIRA"|"CONFLUENCE"|"THIRD_PARTY"|"ALL", mode: "STANDARD"|"ENHANCED"|"AGENTIC" }
const search = async (query, { n = 200, limit = 10, ...opts } = {}) =>
  (await call("search", { query, limit: Math.max(10, limit), ...opts })).results.map((x) => `${x.type} | ${x.title} | ${x.url}\n  ${String(x.snippet ?? x.text ?? "").replace(/!--\S+/g, "").replace(/\s+/g, " ").slice(0, n)}`).join("\n");

// Find a non-primary operation → "name [executeTool]: summary\n  inputs" for the top matches.
const discover = async (query) => {
  const r = await call("discover", { query });
  return [...(r.results ?? []).map((x) => `${x.name} [${x.executeTool ?? "primary"}]: ${String(x.description).slice(0, 200)}\n  inputs: ${(x.inputs ?? []).filter((p) => p.name !== "cloudId").map((p) => p.name + (p.required ? "*" : "")).join(", ")}`), r.more ?? ""].join("\n");
};

// WRITE: transition by transition name or target status (case-insensitive), e.g. transition("FEF-1", "Done").
const transition = async (key, name) => {
  const ts = (await call("listJiraIssueTransitions", { issueIdOrKey: key })).transitions;
  const l = name.toLowerCase();
  const t = ts.find((x) => x.name.toLowerCase() === l) ?? ts.find((x) => x.to?.name?.toLowerCase() === l);
  if (!t) throw new Error(`${key}: no transition "${name}" (have: ${ts.map((x) => x.name === x.to?.name ? x.name : `${x.name} → ${x.to?.name}`).join(", ")})`);
  const r = await call("transitionJiraIssue", { issueIdOrKey: key, transitionId: t.id });
  return `${key} → ${r?.status?.name ?? r?.fields?.status?.name ?? t.to?.name ?? t.name}`;
};

return { cloudId, call, md, issue, jql, page, cql, search, discover, transition };
