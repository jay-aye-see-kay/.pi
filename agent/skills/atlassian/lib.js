// Atlassian (Jira + Confluence) helpers for codemode. Load with:
//   const atl = new Function("tools", await tools.read({ path: "~/.pi/agent/skills/atlassian/lib.js" }))(tools);
// Then: atl.issue / jql / page / cql / search / transition / call. Keep small: read on every load.
// Raw outputs are REST JSON full of self/avatar/schema noise (5–12KB per issue/page) — these trim to text.

const cloudId = "cultureamp.atlassian.net";
const BROWSE = "https://cultureamp.atlassian.net/browse/";
const WIKI = "https://cultureamp.atlassian.net/wiki";

// Any atlassian tool → parsed JSON. Fills cloudId. Throws on isError with the API's message.
const call = async (tool, args = {}) => {
  const r = await tools[`mcp__atlassian__${tool}`]({ cloudId, ...args });
  const t = r.content?.[0]?.text ?? "";
  let j; try { j = JSON.parse(t); } catch { j = t; }
  if (r.isError) {
    let m = j?.message ?? t; try { m = JSON.parse(m).errorMessages?.join("; ") || m; } catch {}
    throw new Error(`atlassian ${tool}: ${typeof m === "string" ? m : JSON.stringify(m)}`.slice(0, 600));
  }
  return j;
};

const who = (u) => u?.displayName ?? "-";
const row = (i) => `${i.key} [${i.fields.status?.name ?? "?"}] ${who(i.fields.assignee)}: ${i.fields.summary}`;

// One issue → compact markdown: header, people, parent, description, last `comments` comments.
const issue = async (key, { comments = 5, fields = [] } = {}) => {
  const i = await call("getJiraIssue", {
    issueIdOrKey: key, responseContentFormat: "markdown",
    fields: ["summary", "status", "issuetype", "assignee", "reporter", "parent", "priority", "labels", "components", "updated", "description", ...(comments ? ["comment"] : []), ...fields],
  });
  const f = i.fields, cs = (f.comment?.comments ?? []).slice(-comments);
  return [
    `${i.key} [${f.status?.name}] (${f.issuetype?.name}) ${f.summary}  ${BROWSE}${i.key}`,
    `assignee ${who(f.assignee)} · reporter ${who(f.reporter)} · updated ${f.updated?.slice(0, 10)}` +
      (f.parent ? ` · parent ${f.parent.key} ${f.parent.fields?.summary ?? ""}` : "") +
      (f.components?.length ? ` · components ${f.components.map((c) => c.name).join(", ")}` : "") + (f.labels?.length ? ` · labels ${f.labels.join(", ")}` : ""),
    ...fields.map((k) => `${k}: ${JSON.stringify(f[k])}`),
    "", f.description ?? "(no description)",
    ...(cs.length ? ["", `## Comments (last ${cs.length} of ${f.comment.comments.length})`, ...cs.map((c) => `\n**${who(c.author)}** ${c.created?.slice(0, 10)}: ${typeof c.body === "string" ? c.body : JSON.stringify(c.body)}`)] : []),
  ].join("\n");
};

// JQL → "KEY [Status] Assignee: Summary" lines (follows nextPageToken up to `max` issues).
const jql = async (q, { max = 50, fields = [] } = {}) => {
  const out = []; let nextPageToken;
  do {
    const r = await call("searchJiraIssuesUsingJql", { jql: q, fields: ["summary", "status", "assignee", ...fields], maxResults: Math.min(100, max - out.length), nextPageToken });
    out.push(...r.issues); nextPageToken = r.isLast ? undefined : r.nextPageToken;
  } while (nextPageToken && out.length < max);
  return out.map((i) => row(i) + fields.map((k) => ` | ${k}: ${JSON.stringify(i.fields[k])}`).join("")).join("\n") || "(no issues)";
};

// Page id or URL (/pages/<id>/… or /wiki/x/<tiny>) → id.
const pageId = (s) => String(s).match(/\/pages\/(\d+)/)?.[1] ?? String(s).match(/\/wiki\/x\/([\w-]+)/)?.[1] ?? String(s);

// Confluence page → "# title\nurl\n\nmarkdown body" (first `n` chars).
const page = async (idOrUrl, n = 30000) => {
  const p = await call("getConfluencePage", { pageId: pageId(idOrUrl), contentFormat: "markdown" });
  return `# ${p.title}\n${WIKI}${p._links?.webui ?? `/pages/${p.id}`} (v${p.version?.number}, ${p.version?.createdAt?.slice(0, 10)})\n\n${String(p.body ?? "").slice(0, n)}`;
};

const ent = (t = "") => t.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// CQL → "id | lastModified | space | title | url" lines, paging via cursor up to `max` (+ "(N of TOTAL)" if cut).
const cql = async (q, max = 100) => {
  const out = []; let cursor, total;
  do {
    const r = await call("searchConfluenceUsingCql", { cql: q, limit: Math.min(100, max - out.length), cursor });
    out.push(...r.results); total = r.totalSize;
    cursor = r._links?.next && decodeURIComponent(r._links.next.match(/cursor=([^&]+)/)?.[1] ?? "");
  } while (cursor && out.length < max);
  return (out.map((x) => `${x.content?.id} | ${x.lastModified?.slice(0, 10)} | ${x.resultGlobalContainer?.title ?? ""} | ${ent(x.title)} | ${WIKI}${x.url}`).join("\n") || "(no results)")
    + (total > out.length ? `\n(${out.length} of ${total})` : "");
};

// Rovo search across Jira + Confluence (natural language; costs Rovo credits) → "type | title | url\n  text" lines.
const search = async (query, n = 200) =>
  (await call("search", { query })).results.map((x) => `${x.type} | ${x.title} | ${x.url}\n  ${String(x.text ?? "").replace(/!--\S+/g, "").replace(/\s+/g, " ").slice(0, n)}`).join("\n");

// WRITE: apply a transition by its name (case-insensitive; in FEF names = target status), e.g. transition("FEF-1", "Done").
const transition = async (key, name) => {
  const ts = (await call("getTransitionsForJiraIssue", { issueIdOrKey: key })).transitions;
  const t = ts.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!t) throw new Error(`${key}: no transition "${name}" (have: ${ts.map((x) => x.name).join(", ")})`);
  await call("transitionJiraIssue", { issueIdOrKey: key, transition: { id: t.id } });
  return `${key} → ${t.name}`;
};

return { cloudId, call, issue, jql, pageId, page, cql, search, transition };
