// Glean helpers for codemode. Load with:
//   const glean = new Function("tools", await tools.read({ path: "~/.pi/agent/skills/glean/lib.js" }))(tools);
// Then: glean.chat / search / show / people / hires / read / activity / call. Keep small: read on every load.
// Raw outputs are huge (search ≈4.5KB/hit, read_document ≈40KB/page, user_activity ≈25KB/day) — these trim them.

let goal = "agent research via pi codemode";

// Any glean tool → text. Fills the required `_user_goal`. Throws on isError.
const call = async (tool, args = {}) => {
  const r = await tools[`mcp__glean__${tool}`]({ _user_goal: goal, ...args });
  const t = (r.content ?? []).map((c) => c.text ?? "").join("\n");
  if (r.isError) throw new Error(`glean ${tool}: ${t.slice(0, 500)}`);
  return t;
};

// Glean Assistant answer (markdown + [^n] source footnotes), without the trace/citation dump.
const chat = async (message, context) => (await call("chat", { message, ...(context && { context }) })).split(/\n---\nchatId:/)[0].trim();

// search → [{ title, source, updated, owner, url, text }] (+ .cursor). `text` = first `n` chars of the snippets.
const search = async (args, n = 300) => {
  const t = await call("search", typeof args === "string" ? { query: args } : args);
  const out = t.split(/\n## \d+\. /).slice(1).map((b) => {
    const f = (k) => b.match(new RegExp(`\\*\\*${k}:\\*\\* ([^•\\n]+)`))?.[1].trim() ?? "";
    return {
      title: b.split("\n")[0].trim(), source: f("Source"), updated: f("Updated").slice(0, 10), owner: f("Owner"), url: f("Link"),
      text: b.split("\n").filter((l) => l.startsWith("> ")).map((l) => l.slice(2)).join(" ").replace(/\s+/g, " ").slice(0, n),
    };
  });
  out.cursor = t.match(/cursor="([^"]+)"/)?.[1];
  return out;
};

// Records → compact lines for returning to the model.
// people/hires records → one line each.
const line = (p) => `${p.startDate} ${p.name} — ${p.title} (${p.department}, ${p.location}) mgr ${p.manager}`;

const show = (rs) => rs.map((r) => `${r.updated} [${r.source}] ${r.title}${r.owner ? ` — ${r.owner}` : ""}\n  ${r.url}${r.text ? `\n  ${r.text}` : ""}`).join("\n");

// employee_search → { people: [{ name, title, department, location, email, startDate, manager, slack }], total, notShown }.
// Only top-level person fields (the nested manager block reuses the same keys). Max 16 shown; cursor is ignored.
const people = async (query) => {
  const t = await call("employee_search", { query });
  const list = t.split(/^  -\n    person:\n/m).slice(1).map((b) => {
    const f = (k) => b.match(new RegExp(`^      ${k}: "?([^"\\n]*)"?$`, "m"))?.[1] ?? "";
    return {
      name: f("name"), title: f("title"), department: f("department"), location: f("location"), email: f("email"), startDate: f("startDate"),
      manager: b.match(/^      manager:\n(?:        .*\n)*?        name: (.*)$/m)?.[1] ?? "", slack: b.match(/slack\.com\/team\/(\w+)/)?.[1] ?? "",
    };
  });
  return { people: list, total: +(t.match(/"datasource=people": (\d+)/)?.[1] ?? list.length), notShown: +(t.match(/notShownCount: (\d+)/)?.[1] ?? 0) };
};

// Everyone who started in [from, to) (YYYY-MM-DD), bisecting the date window until nothing is hidden.
// Don't add keywords to start-date queries (they return 0) — filter the result, e.g. by department.
const hires = async (from, to, depth = 5) => {
  const r = await people(`startafter:${from} startbefore:${to} sortby:hire_date_descending`);
  if (!r.notShown || depth === 0) return r.people;
  const mid = new Date((Date.parse(from) + Date.parse(to)) / 2).toISOString().slice(0, 10);
  if (mid === from || mid === to) return r.people;
  const halves = await Promise.all([hires(from, mid, depth - 1), hires(mid, to, depth - 1)]);
  const seen = new Map(halves.flat().map((p) => [p.email, p]));
  return [...seen.values()];
};

// read_document → [{ title, url, text }] as plain text (Confluence storage HTML stripped). One call for many URLs.
const read = async (urls, n = 20000) => {
  const t = await call("read_document", { urls: [].concat(urls) });
  return t.split(/^  - /m).slice(1).map((b) => {
    let c = b.match(/^ {6}content: ("(?:[^"\\]|\\.)*")$/m)?.[1];
    try { c = JSON.parse(c); } catch {}
    try { const j = JSON.parse(c); c = j.pageBody ?? j.content ?? c; } catch {}
    const ent = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', lsquo: "'", rsquo: "'", ldquo: '"', rdquo: '"', middot: "·", mdash: "—", ndash: "–", hellip: "…", rarr: "→" };
    const text = String(c ?? "").replace(/<ac:parameter[^>]*>[\s\S]*?<\/ac:parameter>/g, "")
      .replace(/<(br|\/p|\/h\d|\/li|\/tr)[^>]*>/g, "\n").replace(/<[^>]+>/g, " ")
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&(\w+);/g, (m, k) => ent[k] ?? m)
      .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
    return { title: b.match(/^ {4}title: "?([^"\n]*)"?$/m)?.[1] ?? "", url: b.match(/^ {4}url: "?([^"\n]*)"?$/m)?.[1] ?? "", text: text.slice(0, n) };
  });
};

// user_activity (my own) → compact lines "when(UTC) ACTIVITY [source] title url", newest first. end is exclusive.
// Big ranges are big (~25KB raw/day) — filter the lines in-script before returning.
// Calendar entries (meetings created/edited, incl. future ones) are dropped unless { calendar: true }.
const activity = async (start_date, end_date, { calendar = false } = {}) => {
  const t = await call("user_activity", { start_date, end_date });
  return t.split(/^  - activity: /m).slice(1).filter((b) => calendar || !/datasource: googlecalendar/.test(b)).map((b) => {
    const f = (k) => b.match(new RegExp(`^ {6}${k}: "?([^"\\n]*)"?$`, "m"))?.[1] ?? "";
    const when = b.match(/activity_touchpoints[^\n]*\n\s*(?:"[^"]*",)?"([^"]+)"/)?.[1] ?? "";
    return `${when.slice(0, 16)} ${b.split("\n")[0]} [${f("datasource")}] ${f("title")} ${f("url")}`;
  }).join("\n");
};

return { setGoal: (g) => (goal = g), call, chat, search, show, line, people, hires, read, activity };
